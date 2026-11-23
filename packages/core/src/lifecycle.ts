const maximumSignedBigInt = 9_223_372_036_854_775_807n;
const maximumJourneySteps = 20;
const maximumJourneyOffsetMinutes = 525_600;
const controlPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const singleLineControlPattern = /[\u0000-\u001f\u007f]/;
const tokenPattern = /\{\{([a-zA-Z][a-zA-Z0-9]{0,59})\}\}/g;
const validTokenPattern = /\{\{[a-zA-Z][a-zA-Z0-9]{0,59}\}\}/g;
const lifecycleVariables = [
  "accountUrl",
  "customerFirstName",
  "storeName",
  "unsubscribeUrl",
] as const;

export const rfmClasses = [
  "PROSPECT",
  "CHAMPIONS",
  "LOYAL",
  "POTENTIAL",
  "NEW",
  "AT_RISK",
  "HIBERNATING",
  "NEEDS_ATTENTION",
] as const;

export type RfmClass = (typeof rfmClasses)[number];

export interface RfmMetrics {
  readonly recencyDays: number | null;
  readonly frequency: number;
  readonly ltvCents: bigint;
}

export interface RfmScores {
  readonly recency: number;
  readonly frequency: number;
  readonly monetary: number;
}

export interface CustomerSegmentDefinition {
  readonly minFrequency: number | null;
  readonly maxFrequency: number | null;
  readonly minNetLtvCents: string | null;
  readonly maxNetLtvCents: string | null;
  readonly lastPurchaseWithinDays: number | null;
  readonly lastPurchaseOlderThanDays: number | null;
  readonly rfmClass: RfmClass | null;
}

export interface LifecycleStepInput {
  readonly position: number;
  readonly offsetMinutes: number;
  readonly subject: string;
  readonly htmlBody: string;
  readonly textBody: string;
  readonly variables: readonly string[];
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RangeError(`${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function nullableInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number | null {
  if (value === null || value === undefined || value === "") return null;
  return integer(value, field, minimum, maximum);
}

function nullableMoney(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value)) {
    throw new TypeError(`${field} must be a non-negative BIGINT decimal string.`);
  }
  if (BigInt(value) > maximumSignedBigInt) throw new RangeError(`${field} exceeds BIGINT.`);
  return value;
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new TypeError(`${field} must contain exactly its supported fields.`);
  }
}

export function normalizeCustomerSegmentDefinition(value: unknown): CustomerSegmentDefinition {
  const input = objectValue(value, "definition");
  const fields = [
    "minFrequency",
    "maxFrequency",
    "minNetLtvCents",
    "maxNetLtvCents",
    "lastPurchaseWithinDays",
    "lastPurchaseOlderThanDays",
    "rfmClass",
  ] as const;
  exactKeys(input, fields, "definition");
  const normalized: CustomerSegmentDefinition = {
    minFrequency: nullableInteger(input.minFrequency, "minFrequency", 0, 2_147_483_647),
    maxFrequency: nullableInteger(input.maxFrequency, "maxFrequency", 0, 2_147_483_647),
    minNetLtvCents: nullableMoney(input.minNetLtvCents, "minNetLtvCents"),
    maxNetLtvCents: nullableMoney(input.maxNetLtvCents, "maxNetLtvCents"),
    lastPurchaseWithinDays: nullableInteger(
      input.lastPurchaseWithinDays,
      "lastPurchaseWithinDays",
      1,
      36_500,
    ),
    lastPurchaseOlderThanDays: nullableInteger(
      input.lastPurchaseOlderThanDays,
      "lastPurchaseOlderThanDays",
      0,
      36_500,
    ),
    rfmClass:
      input.rfmClass === null || input.rfmClass === undefined || input.rfmClass === ""
        ? null
        : rfmClasses.includes(input.rfmClass as RfmClass)
          ? (input.rfmClass as RfmClass)
          : (() => {
              throw new TypeError("rfmClass is not supported.");
            })(),
  };
  if (
    normalized.minFrequency !== null &&
    normalized.maxFrequency !== null &&
    normalized.minFrequency > normalized.maxFrequency
  ) {
    throw new RangeError("minFrequency cannot exceed maxFrequency.");
  }
  if (
    normalized.minNetLtvCents !== null &&
    normalized.maxNetLtvCents !== null &&
    BigInt(normalized.minNetLtvCents) > BigInt(normalized.maxNetLtvCents)
  ) {
    throw new RangeError("minNetLtvCents cannot exceed maxNetLtvCents.");
  }
  if (
    normalized.lastPurchaseWithinDays !== null &&
    normalized.lastPurchaseOlderThanDays !== null &&
    normalized.lastPurchaseOlderThanDays >= normalized.lastPurchaseWithinDays
  ) {
    throw new RangeError("The recency window must contain at least one whole day.");
  }
  return normalized;
}

export function lifecycleText(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < minimum ||
    value.length > maximum ||
    controlPattern.test(value)
  ) {
    throw new TypeError(
      `${field} must contain ${minimum} to ${maximum} trimmed printable characters.`,
    );
  }
  return value;
}

export function lifecycleSingleLineText(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < minimum ||
    value.length > maximum ||
    singleLineControlPattern.test(value)
  ) {
    throw new TypeError(
      `${field} must contain ${minimum} to ${maximum} trimmed single-line printable characters.`,
    );
  }
  return value;
}

function templateTokens(
  step: Pick<LifecycleStepInput, "subject" | "htmlBody" | "textBody">,
): string[] {
  return [
    ...new Set(
      [step.subject, step.htmlBody, step.textBody].flatMap((body) =>
        [...body.matchAll(tokenPattern)].map((match) => match[1]!),
      ),
    ),
  ].sort();
}

export function normalizeLifecycleSteps(value: unknown): LifecycleStepInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumJourneySteps) {
    throw new RangeError(`A journey requires between 1 and ${maximumJourneySteps} steps.`);
  }
  let previousOffset = -1;
  return value.map((candidate, index) => {
    const input = objectValue(candidate, `steps[${index}]`);
    exactKeys(
      input,
      ["position", "offsetMinutes", "subject", "htmlBody", "textBody", "variables"],
      `steps[${index}]`,
    );
    const position = integer(
      input.position,
      `steps[${index}].position`,
      0,
      maximumJourneySteps - 1,
    );
    if (position !== index)
      throw new RangeError("Journey step positions must be contiguous from zero.");
    const offsetMinutes = integer(
      input.offsetMinutes,
      `steps[${index}].offsetMinutes`,
      0,
      maximumJourneyOffsetMinutes,
    );
    if (offsetMinutes <= previousOffset) {
      throw new RangeError("Journey step offsets must be strictly increasing.");
    }
    previousOffset = offsetMinutes;
    const subject = lifecycleSingleLineText(input.subject, `steps[${index}].subject`, 1, 200);
    const htmlBody = lifecycleText(input.htmlBody, `steps[${index}].htmlBody`, 1, 50_000);
    const textBody = lifecycleText(input.textBody, `steps[${index}].textBody`, 1, 20_000);
    if (
      /<\/?(?:script|iframe|object|embed|form|meta|link|base|svg|style)\b|[\s/]on[a-z]+\s*=|(?:javascript|vbscript)\s*:|data\s*:\s*text\/html|expression\s*\(/i.test(
        htmlBody,
      )
    ) {
      throw new TypeError("Lifecycle email HTML contains active or unsafe content.");
    }
    if (
      !Array.isArray(input.variables) ||
      input.variables.some((variable) => typeof variable !== "string") ||
      new Set(input.variables).size !== input.variables.length
    ) {
      throw new TypeError("Lifecycle variables must be unique strings.");
    }
    const variables = [...(input.variables as string[])].sort();
    const used = templateTokens({ subject, htmlBody, textBody });
    if (JSON.stringify(variables) !== JSON.stringify(used)) {
      throw new TypeError("Lifecycle variables must exactly match template usage.");
    }
    if (
      variables.some(
        (variable) => !lifecycleVariables.includes(variable as (typeof lifecycleVariables)[number]),
      )
    ) {
      throw new TypeError("Lifecycle template contains an unsupported variable.");
    }
    if (!variables.includes("unsubscribeUrl")) {
      throw new TypeError("Lifecycle emails must include unsubscribeUrl.");
    }
    for (const body of [subject, htmlBody, textBody]) {
      if (/\{\{|\}\}/.test(body.replaceAll(validTokenPattern, ""))) {
        throw new TypeError("Lifecycle email contains malformed interpolation tokens.");
      }
    }
    return { position, offsetMinutes, subject, htmlBody, textBody, variables };
  });
}

export function rfmScores(metrics: RfmMetrics): RfmScores {
  if (
    (metrics.recencyDays !== null &&
      (!Number.isInteger(metrics.recencyDays) || metrics.recencyDays < 0)) ||
    !Number.isInteger(metrics.frequency) ||
    metrics.frequency < 0 ||
    typeof metrics.ltvCents !== "bigint" ||
    metrics.ltvCents < -maximumSignedBigInt ||
    metrics.ltvCents > maximumSignedBigInt
  ) {
    throw new RangeError("RFM metrics are outside their supported ranges.");
  }
  if ((metrics.recencyDays === null) !== (metrics.frequency === 0)) {
    throw new RangeError("Recency and purchase frequency are inconsistent.");
  }
  const recency = metrics.recencyDays;
  return {
    recency:
      recency === null
        ? 0
        : recency <= 30
          ? 5
          : recency <= 60
            ? 4
            : recency <= 90
              ? 3
              : recency <= 180
                ? 2
                : 1,
    frequency:
      metrics.frequency >= 10
        ? 5
        : metrics.frequency >= 5
          ? 4
          : metrics.frequency >= 3
            ? 3
            : metrics.frequency >= 2
              ? 2
              : metrics.frequency === 1
                ? 1
                : 0,
    monetary:
      metrics.ltvCents >= 100_000_000n
        ? 5
        : metrics.ltvCents >= 50_000_000n
          ? 4
          : metrics.ltvCents >= 20_000_000n
            ? 3
            : metrics.ltvCents >= 5_000_000n
              ? 2
              : metrics.ltvCents > 0n
                ? 1
                : 0,
  };
}

export function classifyRfm(metrics: RfmMetrics): RfmClass {
  const scores = rfmScores(metrics);
  if (metrics.frequency === 0) return "PROSPECT";
  if (scores.recency >= 4 && scores.frequency >= 4 && scores.monetary >= 4) return "CHAMPIONS";
  if (scores.recency >= 3 && scores.frequency >= 3 && scores.monetary >= 3) return "LOYAL";
  if (scores.recency <= 2 && scores.frequency >= 3 && scores.monetary >= 3) return "AT_RISK";
  if (scores.recency >= 4 && metrics.frequency === 1) return "NEW";
  if (scores.recency >= 3 && (scores.frequency >= 2 || scores.monetary >= 2)) return "POTENTIAL";
  if (scores.recency <= 2) return "HIBERNATING";
  return "NEEDS_ATTENTION";
}

export const rfmClassLabels: Readonly<Record<RfmClass, string>> = {
  PROSPECT: "Sin compra pagada",
  CHAMPIONS: "Clientes destacados",
  LOYAL: "Clientes leales",
  POTENTIAL: "Con potencial",
  NEW: "Compra reciente",
  AT_RISK: "En riesgo",
  HIBERNATING: "Hibernando",
  NEEDS_ATTENTION: "Requieren atención",
};

export const customerSegmentStatusLabels = {
  DRAFT: "Borrador",
  ACTIVE: "Activo",
  ARCHIVED: "Archivado",
} as const;

export const lifecycleJourneyStatusLabels = {
  DRAFT: "Borrador",
  ACTIVE: "Activo",
  PAUSED: "Pausado",
  ARCHIVED: "Archivado",
} as const;

export const lifecycleEnrollmentStatusLabels = {
  ACTIVE: "En curso",
  COMPLETED: "Completado",
  CANCELLED: "Cancelado",
  FAILED: "Con error",
} as const;

export const lifecycleMessageStatusLabels = {
  SCHEDULED: "Programado",
  DISPATCHING: "En despacho",
  QUEUED: "En cola de correo",
  SUPPRESSED: "Suprimido",
  CANCELLED: "Cancelado",
  FAILED: "Fallido",
} as const;

export const segmentMembershipReasonLabels = {
  QUALIFIED: "Cumple los criterios y tiene consentimiento",
  FILTER_CHANGED: "Dejó de cumplir los criterios",
  CONSENT_REVOKED: "Consentimiento comercial revocado",
  CUSTOMER_INACTIVE: "Cuenta inactiva o anonimizada",
  SEGMENT_ARCHIVED: "Segmento archivado",
  ANONYMIZED: "Cuenta anonimizada",
} as const;

export const lifecycleEnrollmentExitReasonLabels = {
  CONSENT_REVOKED: "Consentimiento comercial revocado",
  CUSTOMER_INACTIVE: "Cuenta inactiva o anonimizada",
  SEGMENT_EXITED: "Salió del segmento de entrada",
  SEGMENT_ARCHIVED: "Segmento archivado",
  JOURNEY_ARCHIVED: "Journey archivado",
  SUPPRESSED: "Baja o rebote de correo",
  ANONYMIZED: "Cuenta anonimizada",
  DELIVERY_FAILED: "Fallo definitivo del proveedor de correo",
  DELIVERY_DISPATCH_FAILED: "Fallo definitivo de despacho",
} as const;
