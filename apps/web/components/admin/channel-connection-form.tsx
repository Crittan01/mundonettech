"use client";

import { useActionState, useEffect } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  startMercadoLibreConnectionAction,
  type ChannelActionState,
} from "@/lib/actions/admin-channels";

export function ChannelConnectionForm({
  environment,
  redirectUri,
  account,
}: {
  readonly environment: string;
  readonly redirectUri: string;
  readonly account?: { readonly id: string; readonly label: string };
}) {
  const [state, action, pending] = useActionState(startMercadoLibreConnectionAction, {
    status: "idle",
    message: "",
  } satisfies ChannelActionState);
  useEffect(() => {
    if (state.status === "success" && state.authorizationUrl) {
      window.location.assign(state.authorizationUrl);
    }
  }, [state]);
  const suffix = account?.id ?? "new";
  if (state.status === "success" && state.authorizationUrl) {
    return (
      <div className="space-y-3 rounded-lg border border-success bg-card p-4">
        <FormMessage state={state} />
        <p className="text-sm text-muted-foreground">
          Si la redirección no comienza,{" "}
          <a className="underline" href={state.authorizationUrl}>
            autoriza la aplicación en Mercado Libre
          </a>
          .
        </p>
      </div>
    );
  }
  return (
    <form action={action} className="space-y-4">
      {account ? <input type="hidden" name="accountId" value={account.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`channel-label-${suffix}`}>Nombre operativo de la cuenta</Label>
          <Input
            id={`channel-label-${suffix}`}
            name="label"
            defaultValue={state.values?.label ?? account?.label ?? ""}
            maxLength={120}
            autoComplete="off"
            required
          />
          <p className="text-xs text-muted-foreground">
            Ambiente aislado: {environment}. No incluyas datos personales ni secretos.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`channel-client-id-${suffix}`}>Client ID de la aplicación</Label>
          <Input
            id={`channel-client-id-${suffix}`}
            name="clientId"
            defaultValue={state.values?.clientId ?? ""}
            inputMode="numeric"
            pattern="[0-9]{5,64}"
            autoComplete="off"
            required
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`channel-client-secret-${suffix}`}>Client Secret de la aplicación</Label>
        <Input
          id={`channel-client-secret-${suffix}`}
          name="clientSecret"
          type="password"
          minLength={8}
          maxLength={255}
          autoComplete="new-password"
          spellCheck={false}
          required
        />
        <p className="text-xs text-muted-foreground">
          Se cifrará con la bóveda del ambiente y nunca volverá a mostrarse.
        </p>
      </div>
      <div className="rounded-lg border border-border bg-muted p-3 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">
          Redirect URI que debes registrar en Mercado Libre
        </p>
        <code className="mt-1 block break-all">{redirectUri}</code>
        <p className="mt-2">
          La autorización usa PKCE S256 y los permisos offline_access, read y write. Debes entrar
          con la cuenta principal del vendedor, no con una cuenta de colaborador.
        </p>
      </div>
      <FormMessage state={state} />
      <Button type="submit" disabled={pending}>
        {pending
          ? "Preparando conexión segura…"
          : account
            ? "Autorizar de nuevo con PKCE"
            : "Conectar con Mercado Libre"}
      </Button>
    </form>
  );
}
