"use client";

import { useActionState, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { TurnstileField } from "@/components/auth/turnstile-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { initialActionState } from "@/lib/action-state";
import { acceptAdminInvitationAction } from "@/lib/actions/admin-invitation";

export function AdminInvitationForm({
  siteKey,
  nonce,
  defaultEmail,
}: {
  siteKey: string;
  nonce: string;
  defaultEmail: string;
}) {
  const [state, action, pending] = useActionState(acceptAdminInvitationAction, initialActionState);
  const [email, setEmail] = useState(defaultEmail);
  return (
    <form action={action} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="email">Correo invitado</Label>
        <Input
          id="email"
          name="email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="code">Código de invitación</Label>
        <Input
          id="code"
          name="code"
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Contraseña nueva</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirmation">Confirma la contraseña</Label>
        <Input
          id="confirmation"
          name="confirmation"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
        />
      </div>
      <TurnstileField siteKey={siteKey} nonce={nonce} action="admin_invite" state={state} />
      <FormMessage state={state} />
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Activando…" : "Activar invitación"}
      </Button>
    </form>
  );
}
