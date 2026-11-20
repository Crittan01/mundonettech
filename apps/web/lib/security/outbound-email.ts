import "server-only";

import { assertOutboundEmailAllowed, isOutboundEmailDisabled } from "@mundonettech/core";

export function isServerOutboundEmailDisabled(): boolean {
  return isOutboundEmailDisabled(process.env);
}

export function assertServerOutboundEmailAllowed(context: string): void {
  assertOutboundEmailAllowed(process.env, context);
}
