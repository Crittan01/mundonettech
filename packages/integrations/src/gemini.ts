import { createHash } from "node:crypto";

import { fetchWithLimit, IntegrationTransportError, parseHttpJson } from "./integration-http.js";

export const copilotActions = [
  "CONTACT_CUSTOMER",
  "REVISE_PRICING",
  "VERIFY_STOCK",
  "SCHEDULE_FOLLOW_UP",
  "ESCALATE",
] as const;
export const copilotReasons = [
  "HIGH_VALUE",
  "LARGE_VOLUME",
  "EXPIRING_SOON",
  "EXPIRED",
  "STOCK_RISK",
  "NO_PROPOSAL",
  "MULTIPLE_VERSIONS",
  "READY_TO_CONVERT",
] as const;

export interface GeminiCredentials {
  readonly apiKey: string;
  readonly model: string;
  readonly apiUrl: string;
}

export interface B2bCopilotAggregate {
  readonly opportunityStatus: "NEW" | "QUALIFYING" | "PROPOSAL_SENT" | "WON" | "LOST" | "CANCELLED";
  readonly proposalStatus:
    "DRAFT" | "SENT" | "CONVERTED" | "SUPERSEDED" | "CANCELLED" | "EXPIRED" | "NONE";
  readonly proposalVersion: number;
  readonly previousProposalCount: number;
  readonly itemCount: number;
  readonly totalUnits: number;
  readonly subtotalCents: string;
  readonly discountCents: string;
  readonly taxCents: string;
  readonly shippingCents: string;
  readonly totalCents: string;
  readonly stockIssueCount: number;
  readonly secondsToExpiry: number | null;
}

export interface B2bCopilotSuggestion {
  readonly priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  readonly nextAction: (typeof copilotActions)[number];
  readonly reasonCodes: readonly (typeof copilotReasons)[number][];
  readonly confidenceBps: number;
}

export type GeminiErrorCode =
  | "INVALID_CREDENTIALS"
  | "INVALID_INPUT"
  | "HTTP_ERROR"
  | "NETWORK_UNCERTAIN"
  | "INVALID_RESPONSE"
  | "BLOCKED";

export class GeminiProviderError extends Error {
  constructor(
    readonly code: GeminiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GeminiProviderError";
  }
}

function integer(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new GeminiProviderError("INVALID_INPUT", `${field} is outside its permitted range.`);
  }
  return value;
}

function money(value: string, field: string): string {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new GeminiProviderError("INVALID_INPUT", `${field} must be nonnegative integer cents.`);
  }
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n) {
    throw new GeminiProviderError("INVALID_INPUT", `${field} exceeds INT8.`);
  }
  return value;
}

export function parseGeminiCredentials(plaintext: Uint8Array): GeminiCredentials {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    const root = parsed as Record<string, unknown>;
    const apiKey = root.apiKey;
    const model = root.model;
    const configuredUrl = root.apiUrl ?? "https://generativelanguage.googleapis.com/v1beta/models";
    if (
      typeof apiKey !== "string" ||
      apiKey.length < 20 ||
      apiKey.length > 500 ||
      /\s/.test(apiKey) ||
      typeof model !== "string" ||
      !/^[A-Za-z0-9._-]{2,120}$/.test(model) ||
      typeof configuredUrl !== "string"
    ) {
      throw new Error();
    }
    const url = new URL(configuredUrl);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "generativelanguage.googleapis.com" ||
      url.pathname !== "/v1beta/models" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error();
    }
    return { apiKey, model, apiUrl: configuredUrl };
  } catch {
    throw new GeminiProviderError(
      "INVALID_CREDENTIALS",
      "Gemini credentials do not match the isolated API contract.",
    );
  }
}

function validateAggregate(input: B2bCopilotAggregate): B2bCopilotAggregate {
  if (
    !["NEW", "QUALIFYING", "PROPOSAL_SENT", "WON", "LOST", "CANCELLED"].includes(
      input.opportunityStatus,
    )
  ) {
    throw new GeminiProviderError("INVALID_INPUT", "Unknown opportunity status.");
  }
  if (
    !["DRAFT", "SENT", "CONVERTED", "SUPERSEDED", "CANCELLED", "EXPIRED", "NONE"].includes(
      input.proposalStatus,
    )
  ) {
    throw new GeminiProviderError("INVALID_INPUT", "Unknown proposal status.");
  }
  integer(input.proposalVersion, "proposalVersion", 0, 2_147_483_647);
  integer(input.previousProposalCount, "previousProposalCount", 0, 1_000_000);
  integer(input.itemCount, "itemCount", 0, 100);
  integer(input.totalUnits, "totalUnits", 0, 10_000_000);
  integer(input.stockIssueCount, "stockIssueCount", 0, 100);
  if (input.secondsToExpiry !== null)
    integer(input.secondsToExpiry, "secondsToExpiry", -2_678_400, 2_678_400);
  money(input.subtotalCents, "subtotalCents");
  money(input.discountCents, "discountCents");
  money(input.taxCents, "taxCents");
  money(input.shippingCents, "shippingCents");
  money(input.totalCents, "totalCents");
  const merchandise = BigInt(input.subtotalCents) - BigInt(input.discountCents);
  if (
    merchandise < 0n ||
    merchandise + BigInt(input.taxCents) + BigInt(input.shippingCents) !== BigInt(input.totalCents)
  ) {
    throw new GeminiProviderError("INVALID_INPUT", "Aggregate monetary totals do not balance.");
  }
  return input;
}

export function createGeminiRequest(input: B2bCopilotAggregate): {
  readonly body: string;
  readonly promptHash: Uint8Array<ArrayBuffer>;
} {
  const aggregate = validateAggregate(input);
  const prompt = [
    "You are a B2B sales operations classifier. Use only the aggregate JSON supplied below.",
    "Do not infer or generate names, contact details, identifiers, addresses, free text, or personally identifiable information.",
    "Return only JSON matching the response schema. Recommend operational prioritization; never change prices or make legal commitments.",
    JSON.stringify({ schemaVersion: 1, aggregate }),
  ].join("\n");
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 256,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          priority: { type: "STRING", enum: ["LOW", "NORMAL", "HIGH", "URGENT"] },
          nextAction: { type: "STRING", enum: copilotActions },
          reasonCodes: {
            type: "ARRAY",
            minItems: 1,
            maxItems: 5,
            uniqueItems: true,
            items: { type: "STRING", enum: copilotReasons },
          },
          confidenceBps: { type: "INTEGER", minimum: 0, maximum: 10_000 },
        },
        required: ["priority", "nextAction", "reasonCodes", "confidenceBps"],
        additionalProperties: false,
      },
    },
  });
  return {
    body,
    promptHash: Uint8Array.from(createHash("sha256").update(prompt).digest()),
  };
}

function outputFromJson(value: unknown): B2bCopilotSuggestion {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GeminiProviderError("INVALID_RESPONSE", "Gemini returned a non-object suggestion.");
  }
  const root = value as Record<string, unknown>;
  if (Object.keys(root).sort().join(",") !== "confidenceBps,nextAction,priority,reasonCodes") {
    throw new GeminiProviderError(
      "INVALID_RESPONSE",
      "Gemini returned unsupported suggestion fields.",
    );
  }
  const priority = root.priority;
  const nextAction = root.nextAction;
  const reasonCodes = root.reasonCodes;
  const confidenceBps = root.confidenceBps;
  if (
    !["LOW", "NORMAL", "HIGH", "URGENT"].includes(priority as string) ||
    !copilotActions.includes(nextAction as (typeof copilotActions)[number]) ||
    !Array.isArray(reasonCodes) ||
    reasonCodes.length < 1 ||
    reasonCodes.length > 5 ||
    new Set(reasonCodes).size !== reasonCodes.length ||
    !reasonCodes.every((reason) =>
      copilotReasons.includes(reason as (typeof copilotReasons)[number]),
    ) ||
    typeof confidenceBps !== "number"
  ) {
    throw new GeminiProviderError(
      "INVALID_RESPONSE",
      "Gemini returned an invalid suggestion contract.",
    );
  }
  integer(confidenceBps, "confidenceBps", 0, 10_000);
  return {
    priority: priority as B2bCopilotSuggestion["priority"],
    nextAction: nextAction as B2bCopilotSuggestion["nextAction"],
    reasonCodes: reasonCodes as B2bCopilotSuggestion["reasonCodes"],
    confidenceBps,
  };
}

function responseText(root: Record<string, unknown>): string {
  if (root.promptFeedback !== undefined) {
    throw new GeminiProviderError("BLOCKED", "Gemini blocked the zero-PII classification request.");
  }
  const candidates = root.candidates;
  if (!Array.isArray(candidates) || candidates.length !== 1) {
    throw new GeminiProviderError(
      "INVALID_RESPONSE",
      "Gemini returned an unexpected candidate count.",
    );
  }
  const candidate = candidates[0] as Record<string, unknown>;
  const content = candidate?.content;
  if (typeof content !== "object" || content === null) {
    throw new GeminiProviderError("INVALID_RESPONSE", "Gemini returned no suggestion content.");
  }
  const parts = (content as Record<string, unknown>).parts;
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 10) {
    throw new GeminiProviderError("INVALID_RESPONSE", "Gemini returned invalid content parts.");
  }
  const text = parts
    .map((part) =>
      typeof part === "object" && part !== null ? (part as Record<string, unknown>).text : null,
    )
    .filter((part): part is string => typeof part === "string")
    .join("");
  if (text.length < 2 || text.length > 4_000) {
    throw new GeminiProviderError(
      "INVALID_RESPONSE",
      "Gemini returned an empty or oversized suggestion.",
    );
  }
  return text;
}

export class GeminiB2bCopilot {
  constructor(
    private readonly credentials: GeminiCredentials,
    private readonly options: {
      readonly fetchImpl?: typeof fetch;
      readonly timeoutMs?: number;
    } = {},
  ) {}

  async suggest(input: B2bCopilotAggregate): Promise<B2bCopilotSuggestion> {
    const request = createGeminiRequest(input);
    try {
      const response = await fetchWithLimit({
        url: `${this.credentials.apiUrl}/${encodeURIComponent(this.credentials.model)}:generateContent`,
        init: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "x-goog-api-key": this.credentials.apiKey,
          },
          body: request.body,
        },
        fetchImpl: this.options.fetchImpl ?? fetch,
        timeoutMs: this.options.timeoutMs ?? 15_000,
        maximumBytes: 100_000,
      });
      if (response.status === 429 || response.status >= 500) {
        throw new GeminiProviderError(
          "NETWORK_UNCERTAIN",
          "Gemini did not produce a deterministic classification result.",
        );
      }
      if (response.status < 200 || response.status >= 300) {
        throw new GeminiProviderError("HTTP_ERROR", "Gemini rejected the classification request.");
      }
      const parsed = parseHttpJson(response.body);
      const text = responseText(parsed);
      let output: unknown;
      try {
        output = JSON.parse(text);
      } catch {
        throw new GeminiProviderError(
          "INVALID_RESPONSE",
          "Gemini returned non-JSON suggestion content.",
        );
      }
      return outputFromJson(output);
    } catch (error) {
      if (error instanceof GeminiProviderError) throw error;
      if (error instanceof IntegrationTransportError) {
        throw new GeminiProviderError(
          "NETWORK_UNCERTAIN",
          "Gemini communication did not produce a deterministic result.",
        );
      }
      throw error;
    }
  }
}
