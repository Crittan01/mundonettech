"use client";

import { useActionState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { initialActionState } from "@/lib/action-state";
import { markNotificationReadAction } from "@/lib/actions/admin-operations";

export function NotificationReadForm({
  notificationId,
  title,
}: {
  notificationId: string;
  title?: string;
}) {
  const [state, action, pending] = useActionState(markNotificationReadAction, initialActionState);
  return (
    <form action={action} aria-busy={pending} className="space-y-2">
      <input type="hidden" name="notificationId" value={notificationId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Marcando…" : "Marcar como leída"}
        {title ? <span className="sr-only">: {title}</span> : null}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
