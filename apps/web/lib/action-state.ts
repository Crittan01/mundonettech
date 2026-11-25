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

export function actionSuccess(message: string, values?: Record<string, string>): ActionState {
  return values ? { status: "success", message, values } : { status: "success", message };
}

export function formEntries(formData: FormData): [string, FormDataEntryValue][] {
  return Array.from(formData.entries()).filter(([key]) => !key.startsWith("$ACTION_"));
}

export function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export function closedFormObject(
  formData: FormData,
  allowedFields: readonly string[],
): Record<string, string> | null {
  const allowed = new Set(allowedFields);
  const values: Record<string, string> = {};
  for (const [key, value] of formEntries(formData)) {
    if (!allowed.has(key) || typeof value !== "string" || Object.hasOwn(values, key)) return null;
    values[key] = value;
  }
  return values;
}

export function formSnapshot(
  formData: FormData,
  allowedFields?: readonly string[],
): Record<string, string> {
  const allowed = allowedFields ? new Set(allowedFields) : null;
  const snapshot: Record<string, string> = {};
  for (const [key, value] of formEntries(formData)) {
    if (typeof value === "string" && (!allowed || allowed.has(key))) {
      snapshot[key] = value;
    }
  }
  return snapshot;
}
