"use client";

import { useActionState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { initialActionState } from "@/lib/action-state";
import { markNotificationReadAction } from "@/lib/actions/admin-operations";

export function NotificationReadForm({ notificationId }: { notificationId: string }) {
  const [state, action, pending] = useActionState(markNotificationReadAction, initialActionState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="notificationId" value={notificationId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Marcando…" : "Marcar como leída"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
