"use client";

import { useActionState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  disconnectChannelAccountAction,
  refreshChannelAccountAction,
} from "@/lib/actions/admin-channels";
import { initialActionState } from "@/lib/action-state";

export function ChannelAccountActions({
  account,
  canRefresh,
  canDisconnect,
}: {
  readonly account: { readonly id: string; readonly label: string };
  readonly canRefresh: boolean;
  readonly canDisconnect: boolean;
}) {
  const [refreshState, refreshAction, refreshing] = useActionState(
    refreshChannelAccountAction,
    initialActionState,
  );
  const [disconnectState, disconnectAction, disconnecting] = useActionState(
    disconnectChannelAccountAction,
    initialActionState,
  );
  if (!canRefresh && !canDisconnect && !disconnectState.message) {
    return null;
  }
  return (
    <div className="mt-5 space-y-4 border-t border-border pt-4">
      {canRefresh ? (
        <form action={refreshAction} className="space-y-3">
          <input type="hidden" name="accountId" value={account.id} />
          <Button
            type="submit"
            variant="outline"
            disabled={refreshing}
            aria-label={`Renovar token ahora de ${account.label}`}
          >
            {refreshing ? "Renovando token…" : "Renovar token ahora"}
          </Button>
          <FormMessage state={refreshState} />
        </form>
      ) : null}
      {canDisconnect ? (
        <details>
          <summary className="cursor-pointer text-sm font-medium text-destructive">
            Desvincular {account.label}
          </summary>
          <form action={disconnectAction} className="mt-4 max-w-md space-y-3">
            <input type="hidden" name="accountId" value={account.id} />
            <p className="text-xs text-muted-foreground">
              Se revocará el acceso local y se solicitará la revocación a Mercado Libre. Si el
              proveedor no confirma, el acceso local quedará bloqueado igualmente y se indicará la
              incertidumbre.
            </p>
            <div className="space-y-2">
              <Label htmlFor={`disconnect-${account.id}`}>Escribe DESVINCULAR para confirmar</Label>
              <Input
                id={`disconnect-${account.id}`}
                name="confirmation"
                minLength={11}
                maxLength={11}
                autoComplete="off"
                disabled={disconnecting}
                required
              />
            </div>
            <Button type="submit" variant="destructive" disabled={disconnecting}>
              {disconnecting ? "Desvinculando cuenta…" : "Desvincular cuenta"}
            </Button>
            <FormMessage state={disconnectState} />
          </form>
        </details>
      ) : (
        <FormMessage state={disconnectState} />
      )}
    </div>
  );
}
