"use client";

import { useActionState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { refreshMetaCatalogFeedAction } from "@/lib/actions/admin-meta-capi";
import { initialActionState } from "@/lib/action-state";

export function MetaCatalogRefreshButton() {
  const [state, action, pending] = useActionState(refreshMetaCatalogFeedAction, initialActionState);
  return (
    <form action={action} className="space-y-2">
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Actualizando…" : "Actualizar feed"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
