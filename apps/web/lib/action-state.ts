export interface ActionState {
  status: "idle" | "success" | "error";
  message: string;
  fieldErrors?: Record<string, string[]>;
}

export const initialActionState: ActionState = { status: "idle", message: "" };

export function actionError(message: string): ActionState {
  return { status: "error", message };
}

export function actionSuccess(message: string): ActionState {
  return { status: "success", message };
}

export function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}
