export class OutboundEmailDisabledError extends Error {
  constructor(context?: string) {
    super(
      context
        ? `Outbound email dispatch is disabled (${context}) while EMAIL_SEND_DISABLED is active.`
        : "Outbound email dispatch is disabled while EMAIL_SEND_DISABLED is active.",
    );
    this.name = "OutboundEmailDisabledError";
  }
}

export function isOutboundEmailDisabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = env.EMAIL_SEND_DISABLED?.trim().toLowerCase();
  if (!raw || raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  throw new RangeError("EMAIL_SEND_DISABLED must be '0', '1', 'false', or 'true' when defined.");
}

export function assertOutboundEmailAllowed(
  env: Readonly<Record<string, string | undefined>> = process.env,
  context?: string,
): void {
  if (isOutboundEmailDisabled(env)) {
    throw new OutboundEmailDisabledError(context);
  }
}
