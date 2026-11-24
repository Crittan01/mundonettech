"use server";

import { randomUUID } from "node:crypto";

import {
  copilotActionLabels,
  copilotPriorityLabels,
  parseWholeCopToCents,
  type AdminPermission,
} from "@mundonettech/core";
import {
  AdminOperationRateLimitError,
  B2bError,
  consumeAdminOperationRateLimit,
} from "@mundonettech/db";
import { B2bCopilotError } from "@mundonettech/integrations";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  actionError,
  actionSuccess,
  formSnapshot,
  formString,
  type ActionState,
} from "@/lib/action-state";
import { b2bService } from "@/lib/b2b";
import { getDatabase } from "@/lib/db";
import { b2bCopilotService, getPublicSiteUrl } from "@/lib/integrations";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { getRequestSecurityContext } from "@/lib/security/request-context";

export interface B2bIssueActionState extends ActionState {
  readonly proposalUrl?: string;
}

async function audit(permission: AdminPermission = "b2b:write") {
  const session = await getAdminSession({ permission, requireRecentMfa: true });
  const context = await getRequestSecurityContext();
  return {
    actorAdminUserId: session.profile.id,
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
    requestId: randomUUID(),
  };
}

function failure(error: unknown, values?: Record<string, string>): ActionState {
  if (error instanceof AdminOperationRateLimitError) {
    return actionError(
      `Demasiadas solicitudes al Copiloto. Inténtalo de nuevo en ${error.retryAfterSeconds} segundos.`,
      values,
    );
  }
  if (error instanceof AdminAuthorizationError) {
    return actionError(
      error.code === "MFA_STALE"
        ? "Confirma tu autenticador antes de ejecutar esta operación B2B."
        : "Tu sesión no está autorizada para esta operación B2B.",
      values,
    );
  }
  if (error instanceof B2bError) {
    const messages = {
      FORBIDDEN: "Tu rol no está autorizado para esta operación B2B.",
      NOT_FOUND: "El registro B2B solicitado ya no está disponible.",
      CONFLICT: "El registro cambió o tiene dependencias abiertas. Recarga antes de continuar.",
      VALIDATION: "Revisa códigos, SKU, cantidades, precios, versiones y fechas ingresadas.",
      EXPIRED: "La propuesta venció; crea una nueva versión con vigencia futura.",
    } as const;
    return actionError(messages[error.code], values);
  }
  if (error instanceof B2bCopilotError) {
    const messages = {
      FORBIDDEN: "Tu rol no está autorizado para ejecutar el Copiloto.",
      NOT_FOUND: "No hay una credencial Gemini activa o la oportunidad ya no existe.",
      CONFLICT: "La ejecución ya está en curso o requiere un nuevo identificador.",
      PROVIDER: "Gemini no pudo clasificar la oportunidad. No se reintentó automáticamente.",
      INVALID_RESPONSE: "La respuesta persistida del Copiloto no cumple su contrato cerrado.",
    } as const;
    return actionError(messages[error.code], values);
  }
  if (error instanceof z.ZodError || error instanceof TypeError || error instanceof RangeError) {
    return actionError("Revisa los campos, importes, fechas e identificadores ingresados.", values);
  }
  return actionError(
    "No pudimos completar la operación B2B. Recarga e inténtalo de nuevo.",
    values,
  );
}

function id(formData: FormData, key: string): string {
  return z.string().uuid().parse(formString(formData, key));
}

function version(formData: FormData, key = "expectedVersion"): number {
  const raw = formString(formData, key).trim();
  if (!/^(?:0|[1-9][0-9]{0,9})$/.test(raw)) {
    throw new TypeError(`Invalid version field ${key}.`);
  }
  return Number(raw);
}

function text(formData: FormData, key: string, minimum: number, maximum: number): string {
  return z.string().trim().min(minimum).max(maximum).parse(formString(formData, key));
}

function optionalText(formData: FormData, key: string, maximum: number): string | null {
  const value = formString(formData, key).trim();
  return value ? z.string().max(maximum).parse(value) : null;
}

const bogotaMinuteFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Bogota",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function dateInput(formData: FormData, key: string, optional = false): Date | null {
  const raw = formString(formData, key);
  if (!raw && optional) return null;
  const value = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    .parse(raw);
  const date = new Date(`${value}:00-05:00`);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Invalid Bogota date.");
  const parts = bogotaMinuteFormatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const roundTrip = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
  if (roundTrip !== value) throw new TypeError("Invalid Bogota date.");
  return date;
}

function priceListInput(formData: FormData) {
  return {
    code: text(formData, "code", 3, 40),
    name: text(formData, "name", 2, 160),
    description: optionalText(formData, "description", 500),
    validFrom: dateInput(formData, "validFrom", true),
    validTo: dateInput(formData, "validTo", true),
  };
}

function revalidate(opportunityId?: string): void {
  revalidatePath("/admin/b2b");
  if (opportunityId) revalidatePath(`/admin/b2b/${opportunityId}`);
}

type B2bAuditContext = Awaited<ReturnType<typeof audit>>;

const b2bSnapshotFields = new Set([
  "priceListId",
  "itemId",
  "organizationId",
  "opportunityId",
  "proposalId",
  "credentialId",
  "requestId",
  "expectedVersion",
  "expectedOrganizationVersion",
  "expectedPriceListVersion",
  "expectedOpportunityVersion",
  "code",
  "name",
  "description",
  "validFrom",
  "validTo",
  "sku",
  "quantity",
  "unitPrice",
  "expiresAt",
  "status",
]);

function b2bSnapshot(formData: FormData): Record<string, string> {
  return Object.fromEntries(
    Object.entries(formSnapshot(formData)).filter(
      ([key, value]) => b2bSnapshotFields.has(key) && value.length <= 256,
    ),
  );
}

async function execute(
  formData: FormData,
  operation: (
    auditContext: B2bAuditContext,
  ) => Promise<{ message: string; opportunityId?: string }>,
): Promise<ActionState> {
  const values = b2bSnapshot(formData);
  try {
    const auditContext = await audit();
    const result = await operation(auditContext);
    revalidate(result.opportunityId);
    return actionSuccess(result.message);
  } catch (error) {
    return failure(error, error instanceof AdminAuthorizationError ? undefined : values);
  }
}

export async function createB2bPriceListAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async (auditContext) => {
    const record = await b2bService(getDatabase()).createPriceList(
      priceListInput(formData),
      auditContext,
    );
    return { message: `Lista ${record.code} creada como borrador.` };
  });
}

export async function updateB2bPriceListAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async (auditContext) => {
    const record = await b2bService(getDatabase()).updatePriceList(
      id(formData, "priceListId"),
      version(formData),
      priceListInput(formData),
      auditContext,
    );
    return { message: `Lista ${record.code} actualizada.` };
  });
}

export async function activateB2bPriceListAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async (auditContext) => {
    const record = await b2bService(getDatabase()).activatePriceList(
      id(formData, "priceListId"),
      version(formData),
      auditContext,
    );
    return {
      message: `Lista ${record.code} activada con ${record.version} como versión de control.`,
    };
  });
}

export async function archiveB2bPriceListAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async (auditContext) => {
    const record = await b2bService(getDatabase()).archivePriceList(
      id(formData, "priceListId"),
      version(formData),
      auditContext,
    );
    return { message: `Lista ${record.code} archivada sin alterar propuestas históricas.` };
  });
}

export async function upsertB2bPriceListItemAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async (auditContext) => {
    await b2bService(getDatabase()).upsertPriceListItem(
      id(formData, "priceListId"),
      version(formData),
      {
        sku: text(formData, "sku", 1, 64),
        unitPriceCents: parseWholeCopToCents(text(formData, "unitPrice", 1, 30)),
      },
      auditContext,
    );
    return { message: "Precio de variante guardado y versión de la lista incrementada." };
  });
}

export async function removeB2bPriceListItemAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async (auditContext) => {
    await b2bService(getDatabase()).removePriceListItem(
      id(formData, "priceListId"),
      id(formData, "itemId"),
      version(formData),
      auditContext,
    );
    return { message: "Variante retirada del borrador de la lista." };
  });
}

export async function assignB2bOrganizationPriceListAction(
  _previous: ActionState,
  formData: FormData,
) {
  return execute(formData, async (auditContext) => {
    const priceListId = formString(formData, "priceListId");
    const expectedPriceListVersion = priceListId
      ? version(formData, "expectedPriceListVersion")
      : null;
    await b2bService(getDatabase()).assignOrganizationPriceList(
      id(formData, "organizationId"),
      version(formData, "expectedOrganizationVersion"),
      priceListId ? z.string().uuid().parse(priceListId) : null,
      expectedPriceListVersion,
      auditContext,
    );
    return {
      message: priceListId ? "Lista asignada a la organización." : "Asignación de lista retirada.",
    };
  });
}

export async function createB2bProposalAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async (auditContext) => {
    const skus = z
      .array(z.string().trim().min(1).max(64))
      .min(1)
      .max(100)
      .parse(formData.getAll("sku"));
    const quantities = z
      .array(
        z
          .string()
          .regex(/^[0-9]+$/)
          .transform(Number)
          .pipe(z.number().int().min(1).max(100_000)),
      )
      .min(1)
      .max(100)
      .parse(formData.getAll("quantity"));
    const prices = z
      .array(z.string().trim().max(30))
      .min(1)
      .max(100)
      .parse(formData.getAll("unitPrice"));
    if (skus.length !== quantities.length || skus.length !== prices.length)
      throw new TypeError("Invalid proposal rows.");
    const opportunityId = id(formData, "opportunityId");
    const proposal = await b2bService(getDatabase()).createProposal({
      opportunityId,
      expectedVersion: version(formData),
      expiresAt: dateInput(formData, "expiresAt")!,
      commercialNotes: optionalText(formData, "commercialNotes", 2000),
      items: skus.map((sku, index) => ({
        sku,
        quantity: quantities[index]!,
        ...(prices[index] ? { unitPriceCents: parseWholeCopToCents(prices[index]) } : {}),
      })),
      audit: auditContext,
    });
    return {
      message: `Borrador ${proposal.version} creado con impuestos y totales sellados.`,
      opportunityId,
    };
  });
}

export async function issueB2bProposalAction(
  _previous: B2bIssueActionState,
  formData: FormData,
): Promise<B2bIssueActionState> {
  const values = b2bSnapshot(formData);
  try {
    const auditContext = await audit();
    const issued = await b2bService(getDatabase()).issueProposal(
      id(formData, "proposalId"),
      version(formData, "expectedOpportunityVersion"),
      auditContext,
    );
    revalidate(issued.proposal.opportunityId);
    return {
      ...actionSuccess(
        `Versión ${issued.proposal.version} emitida. Copia el enlace ahora: solo se muestra una vez.`,
      ),
      proposalUrl: `${getPublicSiteUrl()}/propuesta/${issued.token}`,
    };
  } catch (error) {
    return failure(error, values);
  }
}

export async function cancelB2bProposalAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async (auditContext) => {
    const opportunityId = id(formData, "opportunityId");
    await b2bService(getDatabase()).cancelProposal(
      id(formData, "proposalId"),
      version(formData, "expectedOpportunityVersion"),
      auditContext,
    );
    return { message: "Propuesta cancelada y carrito B2B invalidado.", opportunityId };
  });
}

export async function closeB2bOpportunityAction(_previous: ActionState, formData: FormData) {
  return execute(formData, async (auditContext) => {
    const opportunityId = id(formData, "opportunityId");
    const status = z.enum(["LOST", "CANCELLED"]).parse(formString(formData, "status"));
    await b2bService(getDatabase()).closeOpportunity(
      opportunityId,
      version(formData),
      status,
      auditContext,
    );
    return {
      message: status === "LOST" ? "Oportunidad marcada como perdida." : "Oportunidad cancelada.",
      opportunityId,
    };
  });
}

export async function runB2bCopilotAction(_previous: ActionState, formData: FormData) {
  const values = b2bSnapshot(formData);
  try {
    const auditContext = await audit();
    const db = getDatabase();
    await consumeAdminOperationRateLimit(db, {
      operation: "b2b.copilot.run",
      actorAdminUserId: auditContext.actorAdminUserId,
      ipHash: auditContext.ipHash,
      limit: 20,
      windowSeconds: 60,
    });
    const opportunityId = id(formData, "opportunityId");
    const credentialId = id(formData, "credentialId");
    const result = await b2bCopilotService(db).run({
      opportunityId,
      credentialId,
      requestId: id(formData, "requestId"),
      audit: auditContext,
    });
    revalidate(opportunityId);
    return actionSuccess(
      `${result.replayed ? "Resultado recuperado" : "Clasificación completada"}: prioridad ${copilotPriorityLabels[result.suggestion.priority].toLowerCase()}, ${copilotActionLabels[result.suggestion.nextAction]} (${result.suggestion.confidenceBps / 100}% de confianza).`,
    );
  } catch (error) {
    return failure(
      error,
      error instanceof AdminAuthorizationError ? undefined : { ...values, requestId: randomUUID() },
    );
  }
}
