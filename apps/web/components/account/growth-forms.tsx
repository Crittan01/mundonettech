"use client";

import { useActionState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { attributeReferralAction, createReferralCodeAction } from "@/lib/actions/growth";
import { initialActionState } from "@/lib/action-state";

export function CreateReferralCodeForm() {
  const [state, action, pending] = useActionState(createReferralCodeAction, initialActionState);
  return (
    <form action={action} className="space-y-3">
      <Button type="submit" disabled={pending}>
        {pending ? "Generando…" : "Generar mi código de referidos"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function AttributeReferralForm({ initialCode }: { readonly initialCode: string }) {
  const [state, action, pending] = useActionState(attributeReferralAction, initialActionState);
  const code = state.status === "error" ? (state.values?.code ?? initialCode) : initialCode;
  return (
    <form action={action} className="space-y-4 rounded-xl border border-border bg-card p-5">
      <div className="space-y-2">
        <Label htmlFor="referral-code">Código de quien te refirió</Label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Input
            key={code}
            id="referral-code"
            name="code"
            defaultValue={code}
            minLength={12}
            maxLength={12}
            required
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
            aria-describedby="referral-code-help"
            className="uppercase"
          />
          <Button type="submit" disabled={pending}>
            {pending ? "Validando…" : "Atribuir código"}
          </Button>
        </div>
        <p id="referral-code-help" className="text-sm text-muted-foreground">
          Debes atribuirlo antes de tu primera compra pagada. No se permiten autorreferidos.
        </p>
      </div>
      <FormMessage state={state} />
    </form>
  );
}
