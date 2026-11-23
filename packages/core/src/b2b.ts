export const opportunityStatusLabels = {
  NEW: "Nueva",
  QUALIFYING: "En calificación",
  PROPOSAL_SENT: "Propuesta enviada",
  WON: "Ganada",
  LOST: "Perdida",
  CANCELLED: "Cancelada",
} as const;

export const opportunityProposalStatusLabels = {
  DRAFT: "Borrador",
  SENT: "Vigente",
  CONVERTED: "Convertida",
  SUPERSEDED: "Reemplazada",
  CANCELLED: "Cancelada",
  EXPIRED: "Vencida",
} as const;

export const priceListStatusLabels = {
  DRAFT: "Borrador",
  ACTIVE: "Activa",
  ARCHIVED: "Archivada",
} as const;

export const copilotActionLabels = {
  CONTACT_CUSTOMER: "Contactar al cliente",
  REVISE_PRICING: "Revisar condiciones comerciales",
  VERIFY_STOCK: "Verificar disponibilidad",
  SCHEDULE_FOLLOW_UP: "Programar seguimiento",
  ESCALATE: "Escalar a un responsable",
} as const;

export const copilotReasonLabels = {
  HIGH_VALUE: "Valor comercial alto",
  LARGE_VOLUME: "Volumen de unidades alto",
  EXPIRING_SOON: "Propuesta próxima a vencer",
  EXPIRED: "Propuesta vencida",
  STOCK_RISK: "Riesgo de disponibilidad",
  NO_PROPOSAL: "Aún no tiene propuesta",
  MULTIPLE_VERSIONS: "Requirió varias versiones",
  READY_TO_CONVERT: "Lista para conversión",
} as const;

export function normalizePriceListCode(value: string): string {
  if (typeof value !== "string") throw new TypeError("Price list code must be a string.");
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{2,39}$/.test(normalized)) {
    throw new TypeError(
      "Price list code must start with a letter and contain 3 to 40 letters, digits, underscores or hyphens.",
    );
  }
  return normalized;
}

export function assertB2bExpiry(value: Date, now: Date): Date {
  if (
    !(value instanceof Date) ||
    Number.isNaN(value.getTime()) ||
    !(now instanceof Date) ||
    Number.isNaN(now.getTime())
  ) {
    throw new TypeError("Proposal dates must be valid.");
  }
  const maximum = now.getTime() + 30 * 86_400_000;
  if (value.getTime() <= now.getTime() + 3_600_000 || value.getTime() > maximum) {
    throw new RangeError("Proposal expiration must be between one hour and thirty days ahead.");
  }
  return value;
}
