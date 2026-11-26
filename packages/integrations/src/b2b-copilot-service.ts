import { createHash } from "node:crypto";

import { hasAdminPermission, isAdminRole } from "@mundonettech/core";
import {
  AdminActorAuthorizationError,
  assertAdminActorInTransaction,
  hasUniqueViolation,
  Prisma,
  type IntegrationCredential,
  type IntegrationEnvironment,
  type PrismaClient,
} from "@mundonettech/db";

import {
  CredentialNotFoundError,
  CredentialRevokedError,
  type IntegrationCredentialVault,
} from "./credential-vault.js";
import {
  copilotReasons,
  createGeminiRequest,
  GeminiB2bCopilot,
  GeminiProviderError,
  parseGeminiCredentials,
  type B2bCopilotAggregate,
  type B2bCopilotSuggestion,
} from "./gemini.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class B2bCopilotError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "FORBIDDEN" | "CONFLICT" | "PROVIDER" | "INVALID_RESPONSE",
    message: string,
  ) {
    super(message);
    this.name = "B2bCopilotError";
  }
}

export interface B2bCopilotAudit {
  readonly actorAdminUserId: string;
  readonly ipHash: Uint8Array;
  readonly userAgentHash?: Uint8Array | null;
  readonly requestId?: string;
}

export interface B2bCopilotRunResult {
  readonly id: string;
  readonly opportunityId: string;
  readonly suggestion: B2bCopilotSuggestion;
  readonly replayed: boolean;
}

function assertUuid(value: string, field: string): void {
  if (!uuidPattern.test(value)) throw new B2bCopilotError("CONFLICT", `${field} must be a UUID.`);
}

function aggregateInput(
  opportunity: {
    status: B2bCopilotAggregate["opportunityStatus"];
    proposals: Array<{
      version: number;
      status: B2bCopilotAggregate["proposalStatus"];
      subtotalCents: bigint;
      discountCents: bigint;
      taxCents: bigint;
      shippingCents: bigint;
      totalCents: bigint;
      expiresAt: Date;
      items: Array<{ quantity: number }>;
      cart: { pricingIssues: Prisma.JsonValue } | null;
    }>;
    _count: { proposals: number };
  },
  now: Date,
): B2bCopilotAggregate {
  const proposal = opportunity.proposals[0];
  const seconds = proposal
    ? Math.trunc((proposal.expiresAt.getTime() - now.getTime()) / 1000)
    : null;
  const effectiveProposalStatus = proposal
    ? proposal.status === "SENT" && proposal.expiresAt <= now
      ? "EXPIRED"
      : proposal.status
    : "NONE";
  return {
    opportunityStatus: opportunity.status,
    proposalStatus: effectiveProposalStatus,
    proposalVersion: proposal?.version ?? 0,
    previousProposalCount: Math.max(0, opportunity._count.proposals - (proposal ? 1 : 0)),
    itemCount: proposal?.items.length ?? 0,
    totalUnits: proposal?.items.reduce((sum, item) => sum + item.quantity, 0) ?? 0,
    subtotalCents: (proposal?.subtotalCents ?? 0n).toString(),
    discountCents: (proposal?.discountCents ?? 0n).toString(),
    taxCents: (proposal?.taxCents ?? 0n).toString(),
    shippingCents: (proposal?.shippingCents ?? 0n).toString(),
    totalCents: (proposal?.totalCents ?? 0n).toString(),
    stockIssueCount:
      proposal?.cart && Array.isArray(proposal.cart.pricingIssues)
        ? proposal.cart.pricingIssues.length
        : 0,
    secondsToExpiry: seconds === null ? null : Math.max(-2_678_400, Math.min(2_678_400, seconds)),
  };
}

function suggestionFromJson(value: Prisma.JsonValue): B2bCopilotSuggestion {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new B2bCopilotError("INVALID_RESPONSE", "Persisted Copilot output is invalid.");
  }
  const root = value as Record<string, unknown>;
  const priority = root.priority;
  const nextAction = root.nextAction;
  const reasonCodes = root.reasonCodes;
  const confidenceBps = root.confidenceBps;
  if (
    !["LOW", "NORMAL", "HIGH", "URGENT"].includes(priority as string) ||
    ![
      "CONTACT_CUSTOMER",
      "REVISE_PRICING",
      "VERIFY_STOCK",
      "SCHEDULE_FOLLOW_UP",
      "ESCALATE",
    ].includes(nextAction as string) ||
    !Array.isArray(reasonCodes) ||
    reasonCodes.length < 1 ||
    reasonCodes.length > 5 ||
    new Set(reasonCodes).size !== reasonCodes.length ||
    !reasonCodes.every((reason) =>
      copilotReasons.includes(reason as (typeof copilotReasons)[number]),
    ) ||
    typeof confidenceBps !== "number" ||
    !Number.isSafeInteger(confidenceBps) ||
    confidenceBps < 0 ||
    confidenceBps > 10_000
  ) {
    throw new B2bCopilotError("INVALID_RESPONSE", "Persisted Copilot output is invalid.");
  }
  return {
    priority: priority as B2bCopilotSuggestion["priority"],
    nextAction: nextAction as B2bCopilotSuggestion["nextAction"],
    reasonCodes: reasonCodes as B2bCopilotSuggestion["reasonCodes"],
    confidenceBps,
  };
}

export class B2bCopilotService {
  constructor(
    private readonly db: PrismaClient,
    private readonly options: {
      readonly vault: Pick<IntegrationCredentialVault, "reveal">;
      readonly environment?: IntegrationEnvironment;
      readonly fetchImpl?: typeof fetch;
      readonly timeoutMs?: number;
    },
  ) {}

  private async credential(id: string): Promise<IntegrationCredential> {
    const record = await this.db.integrationCredential.findFirst({
      where: {
        id,
        provider: "gemini",
        ...(this.options.environment ? { environment: this.options.environment } : {}),
        revokedAt: null,
      },
    });
    if (!record) throw new B2bCopilotError("NOT_FOUND", "Active Gemini credential not found.");
    return record;
  }

  private async actor(audit: B2bCopilotAudit) {
    if (
      !uuidPattern.test(audit.actorAdminUserId) ||
      audit.ipHash.length !== 32 ||
      (audit.userAgentHash !== undefined &&
        audit.userAgentHash !== null &&
        audit.userAgentHash.length !== 32)
    ) {
      throw new B2bCopilotError("FORBIDDEN", "Invalid Copilot audit context.");
    }
    const actor = await this.db.adminUser.findFirst({
      where: { id: audit.actorAdminUserId, status: "ACTIVE", deletedAt: null },
    });
    if (!actor || !isAdminRole(actor.role) || !hasAdminPermission(actor.role, "b2b:write")) {
      throw new B2bCopilotError("FORBIDDEN", "The administrator cannot run the B2B Copilot.");
    }
    return actor;
  }

  private async lockedActor(tx: Prisma.TransactionClient, actorAdminUserId: string): Promise<void> {
    try {
      await assertAdminActorInTransaction(tx, actorAdminUserId, "b2b:write");
    } catch (error) {
      if (error instanceof AdminActorAuthorizationError) {
        throw new B2bCopilotError("FORBIDDEN", "The administrator cannot run the B2B Copilot.");
      }
      throw error;
    }
  }

  private async completeRun(options: {
    readonly runId: string;
    readonly audit: B2bCopilotAudit;
    readonly status: "SUCCEEDED" | "FAILED";
    readonly output?: B2bCopilotSuggestion;
    readonly failureCode?: string;
  }) {
    await this.db.$transaction(async (tx) => {
      await this.lockedActor(tx, options.audit.actorAdminUserId);
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      const updated = await tx.opportunityCopilotRun.updateMany({
        where: { id: options.runId, status: "REQUESTED" },
        data: {
          status: options.status,
          ...(options.output
            ? {
                output: {
                  priority: options.output.priority,
                  nextAction: options.output.nextAction,
                  reasonCodes: [...options.output.reasonCodes],
                  confidenceBps: options.output.confidenceBps,
                },
              }
            : {}),
          ...(options.failureCode ? { failureCode: options.failureCode } : {}),
          completedAt: nowRows[0]!.now,
        },
      });
      if (updated.count !== 1) {
        throw new B2bCopilotError("CONFLICT", "The Copilot run was completed concurrently.");
      }
      await tx.adminActionLog.create({
        data: {
          actorAdminUserId: options.audit.actorAdminUserId,
          action:
            options.status === "SUCCEEDED" ? "B2B_COPILOT_RUN_SUCCEEDED" : "B2B_COPILOT_RUN_FAILED",
          targetType: "OpportunityCopilotRun",
          targetId: options.runId,
          requestId: options.audit.requestId ?? options.runId,
          ipHash: Uint8Array.from(options.audit.ipHash),
          userAgentHash: options.audit.userAgentHash
            ? Uint8Array.from(options.audit.userAgentHash)
            : null,
          metadata: {
            status: options.status,
            ...(options.failureCode ? { failureCode: options.failureCode } : {}),
          },
        },
      });
    });
  }

  async run(input: {
    readonly opportunityId: string;
    readonly requestId: string;
    readonly credentialId: string;
    readonly audit: B2bCopilotAudit;
  }): Promise<B2bCopilotRunResult> {
    assertUuid(input.opportunityId, "opportunityId");
    assertUuid(input.requestId, "requestId");
    assertUuid(input.credentialId, "credentialId");
    const actor = await this.actor(input.audit);
    const existing = await this.db.opportunityCopilotRun.findUnique({
      where: { id: input.requestId },
    });
    if (existing) {
      if (
        existing.status === "SUCCEEDED" &&
        existing.opportunityId === input.opportunityId &&
        existing.credentialId === input.credentialId &&
        existing.output
      ) {
        return {
          id: existing.id,
          opportunityId: existing.opportunityId,
          suggestion: suggestionFromJson(existing.output),
          replayed: true,
        };
      }
      throw new B2bCopilotError(
        "CONFLICT",
        "This Copilot request is already running or requires a new request identifier.",
      );
    }
    const nowRows = await this.db.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
    const opportunity = await this.db.opportunity.findUnique({
      where: { id: input.opportunityId },
      select: {
        status: true,
        _count: { select: { proposals: true } },
        proposals: {
          orderBy: [{ version: "desc" as const }],
          take: 1,
          select: {
            version: true,
            status: true,
            subtotalCents: true,
            discountCents: true,
            taxCents: true,
            shippingCents: true,
            totalCents: true,
            expiresAt: true,
            items: { select: { quantity: true } },
            cart: { select: { pricingIssues: true } },
          },
        },
      },
    });
    if (!opportunity) throw new B2bCopilotError("NOT_FOUND", "Opportunity not found.");
    const credential = await this.credential(input.credentialId);
    const aggregate = aggregateInput(opportunity, nowRows[0]!.now);
    const request = createGeminiRequest(aggregate);
    const inputHash = Uint8Array.from(
      createHash("sha256").update(JSON.stringify(aggregate)).digest(),
    );
    let plaintext: Uint8Array | undefined;
    let created = false;
    try {
      plaintext = await this.options.vault.reveal(credential.id);
      const credentials = parseGeminiCredentials(plaintext);
      await this.db.$transaction(async (tx) => {
        await this.lockedActor(tx, actor.id);
        await tx.opportunityCopilotRun.create({
          data: {
            id: input.requestId,
            opportunityId: input.opportunityId,
            credentialId: credential.id,
            model: credentials.model,
            inputHash,
            promptHash: request.promptHash,
            requestedByAdminUserId: actor.id,
          },
        });
        await tx.adminActionLog.create({
          data: {
            actorAdminUserId: actor.id,
            action: "B2B_COPILOT_RUN_REQUESTED",
            targetType: "OpportunityCopilotRun",
            targetId: input.requestId,
            requestId: input.audit.requestId ?? input.requestId,
            ipHash: Uint8Array.from(input.audit.ipHash),
            userAgentHash: input.audit.userAgentHash
              ? Uint8Array.from(input.audit.userAgentHash)
              : null,
            metadata: { opportunityId: input.opportunityId, credentialId: credential.id },
          },
        });
      });
      created = true;
      const provider = new GeminiB2bCopilot(credentials, {
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
        ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
      });
      const suggestion = await provider.suggest(aggregate);
      await this.completeRun({
        runId: input.requestId,
        audit: input.audit,
        status: "SUCCEEDED",
        output: suggestion,
      });
      return {
        id: input.requestId,
        opportunityId: input.opportunityId,
        suggestion,
        replayed: false,
      };
    } catch (error) {
      if (created) {
        const failureCode = error instanceof GeminiProviderError ? error.code : "PROVIDER_FAILURE";
        await this.completeRun({
          runId: input.requestId,
          audit: input.audit,
          status: "FAILED",
          failureCode,
        }).catch(() => undefined);
      }
      if (error instanceof CredentialNotFoundError || error instanceof CredentialRevokedError) {
        throw new B2bCopilotError("NOT_FOUND", "Active Gemini credential not found.");
      }
      if (hasUniqueViolation(error)) {
        throw new B2bCopilotError("CONFLICT", "This Copilot request already exists.");
      }
      if (error instanceof GeminiProviderError) {
        throw new B2bCopilotError(
          "PROVIDER",
          "Gemini could not complete the zero-PII classification.",
        );
      }
      throw error;
    } finally {
      plaintext?.fill(0);
    }
  }
}
