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

export function FieldErrors({
  id,
  messages,
}: Readonly<{ id: string; messages: readonly string[] | undefined }>) {
  if (!messages?.length) return null;
  return (
    <ul id={id} className="space-y-1 text-sm text-destructive">
      {messages.map((message, index) => (
        <li key={`${index}-${message}`}>{message}</li>
      ))}
    </ul>
  );
}
