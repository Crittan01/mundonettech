export interface ActionState {
  status: "idle" | "success" | "error";
  message: string;
  fieldErrors?: Record<string, string[]>;
  values?: Record<string, string>;
}

export const initialActionState: ActionState = { status: "idle", message: "" };

export function actionError(message: string, values?: Record<string, string>): ActionState {
  return values ? { status: "error", message, values } : { status: "error", message };
}

export function actionSuccess(message: string): ActionState {
  return { status: "success", message };
}

export function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export function formSnapshot(formData: FormData): Record<string, string> {
  const snapshot: Record<string, string> = {};
  formData.forEach((value, key) => {
    if (typeof value === "string") {
      snapshot[key] = value;
    }
  });
  return snapshot;
}
