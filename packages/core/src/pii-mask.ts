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

const sensitiveAuditKeyWords = new Set([
  "email",
  "emails",
  "phone",
  "phones",
  "token",
  "tokens",
  "secret",
  "secrets",
  "password",
  "passwords",
  "credential",
  "credentials",
  "plaintext",
  "plaintexts",
  "code",
  "codes",
  "hash",
  "hashes",
  "cookie",
  "cookies",
  "authorization",
  "authorizations",
  "address",
  "addresses",
  "cedula",
  "cedulas",
  "nit",
  "nits",
  "ip",
  "ips",
  "useragent",
  "useragents",
  "description",
  "descriptions",
  "recipient",
  "recipients",
  "script",
  "scripts",
  "accountname",
  "accountnames",
  "storagekey",
  "storagekeys",
  "posterkey",
  "posterkeys",
  "usdzkey",
  "usdzkeys",
  "objectkey",
  "objectkeys",
  "xml",
  "xmls",
  "apikey",
  "apikeys",
  "privatekey",
  "privatekeys",
  "passphrase",
  "passphrases",
  "jwt",
  "jwts",
  "document",
  "documents",
  "documentnumber",
  "taxid",
  "taxids",
  "identification",
  "identifications",
  "fullname",
  "givenname",
  "familyname",
  "signer",
  "signers",
  "accesstoken",
  "refreshtoken",
]);
const safeOperationalAuditKeys = new Set(["statuscode", "httpstatus", "documentid"]);
const safeSha256AuditKeys = new Set([
  "titlehash",
  "seotitlehash",
  "seodescriptionhash",
  "contenthash",
]);
const sha256HexPattern = /^[0-9a-f]{64}$/i;
const maxRawAuditStringScanLength = 4096;
const sensitiveStringPatterns = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\bBearer\s+[^\s,;]+/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:[^\s/@]+@[^\s]+/gi,
  /\bpostgres(?:ql)?:\/\/[^\s]+/gi,
  /([?&](?:access_token|refresh_token|api_key|apikey|token|secret|password|passphrase|key|signature|code)=)[^&\s#]+/gi,
  /(?<![A-Za-z0-9._%+-/])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g,
];

function redactSensitiveStringValue(raw: string): string {
  let sanitized =
    raw.length > maxRawAuditStringScanLength ? raw.slice(0, maxRawAuditStringScanLength) : raw;
  for (const pattern of sensitiveStringPatterns) {
    sanitized = sanitized.replace(pattern, (...args) => {
      const capturedPrefix = typeof args[1] === "string" ? args[1] : "";
      return `${capturedPrefix}[redactado]`;
    });
  }
  return sanitized.length > 300 ? `${sanitized.slice(0, 297)}...` : sanitized;
}

function auditKeySegments(key: string): string[] {
  return key
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isSensitiveAuditKey(key: string): boolean {
  const segments = auditKeySegments(key);
  const normalized = segments.join("");
  if (safeOperationalAuditKeys.has(normalized)) return false;
  return segments.some((segment, index) => {
    const next = segments[index + 1] ?? "";
    return sensitiveAuditKeyWords.has(segment) || sensitiveAuditKeyWords.has(segment + next);
  });
}

export function sanitizeAuditValue(value: unknown, key = "", depth = 0): unknown {
  if (key && isSensitiveAuditKey(key)) {
    const normalized = auditKeySegments(key).join("");
    if (
      safeSha256AuditKeys.has(normalized) &&
      typeof value === "string" &&
      sha256HexPattern.test(value)
    ) {
      return value.toLowerCase();
    }
    return "[redactado]";
  }
  if (depth > 4) return "[truncado]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? value : "[inválido]";
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "[inválido]" : value.toISOString();
  }
  if (typeof value === "string") return redactSensitiveStringValue(value);
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
