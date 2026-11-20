import type { ActionState } from "@/lib/action-state";

export interface MfaState extends ActionState {
  factorId?: string;
  qrCode?: string;
  secret?: string;
  recoveryCodes?: string[];
  completed?: boolean;
}

export const initialMfaState: MfaState = { status: "idle", message: "" };
