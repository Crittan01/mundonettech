export function maskEmail(value: string | null | undefined): string {
  if (!value) return "No disponible";
  const at = value.lastIndexOf("@");
  if (at < 1 || at === value.length - 1) return "•••";
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const visibleLocal = local.length === 1 ? local : `${local.slice(0, 1)}•••`;
  return `${visibleLocal}@${domain}`;
}

export function maskPhone(value: string | null | undefined): string {
  if (!value) return "No disponible";
  const digits = value.replace(/\D/g, "");
  if (digits.length < 4) return "••••";
  return `••••${digits.slice(-4)}`;
}

export function maskName(value: string | null | undefined): string {
  const normalized = value?.trim();
  if (!normalized) return "No disponible";
  return `${normalized.slice(0, 1)}•••`;
}

export function maskIdentifier(value: string | null | undefined): string {
  if (!value) return "No disponible";
  return value.length <= 8 ? "••••••••" : `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

export function sanitizeAuditValue(value: unknown, key = "", depth = 0): unknown {
  if (/(?:email|phone|token|secret|password|credential|plaintext|code|hash)/i.test(key)) {
    return "[redactado]";
  }
  if (depth > 4) return "[truncado]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : "[inválido]";
  if (typeof value === "string") return value.length > 300 ? `${value.slice(0, 297)}...` : value;
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => sanitizeAuditValue(item, key, depth + 1));
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 50)) {
      if (!/^[\w .-]{1,80}$/.test(childKey)) continue;
      result[childKey] = sanitizeAuditValue(childValue, childKey, depth + 1);
    }
    return result;
  }
  return "[no disponible]";
}
