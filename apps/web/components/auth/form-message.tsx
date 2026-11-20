import type { ActionState } from "@/lib/action-state";

export function FormMessage({ state }: Readonly<{ state: ActionState }>) {
  if (!state.message) return null;
  return (
    <p
      className={state.status === "error" ? "text-sm text-destructive" : "text-sm text-foreground"}
      role={state.status === "error" ? "alert" : "status"}
    >
      {state.message}
    </p>
  );
}
