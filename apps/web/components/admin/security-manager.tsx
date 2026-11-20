"use client";

import { useActionState } from "react";

import { RecoveryCodes } from "@/components/admin/admin-auth-forms";
import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { initialActionState } from "@/lib/action-state";
import { initialMfaState } from "@/lib/security/mfa-state";
import { regenerateAdminRecoveryCodesAction, stepUpAdminAction } from "@/lib/actions/admin-auth";

export function SecurityManager({ factorId, recent }: { factorId: string; recent: boolean }) {
  const [stepUp, stepUpAction, stepping] = useActionState(stepUpAdminAction, initialActionState);
  const [regenerated, regenerateAction, regenerating] = useActionState(
    regenerateAdminRecoveryCodesAction,
    initialMfaState,
  );
  const confirmed = recent || stepUp.status === "success";
  if (regenerated.recoveryCodes) return <RecoveryCodes codes={regenerated.recoveryCodes} />;
  return (
    <div className="space-y-5">
      {!confirmed ? (
        <form action={stepUpAction} className="space-y-4 rounded-lg border border-border p-4">
          <h2 className="font-semibold">Confirma tu identidad</h2>
          <p className="text-sm text-muted-foreground">
            Han pasado más de diez minutos desde tu último segundo factor.
          </p>
          <input type="hidden" name="factorId" value={factorId} />
          <div className="space-y-2">
            <Label htmlFor="step-up-code">Código actual del autenticador</Label>
            <Input
              id="step-up-code"
              name="code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
            />
          </div>
          <FormMessage state={stepUp} />
          <Button type="submit" disabled={stepping}>
            {stepping ? "Confirmando…" : "Confirmar identidad"}
          </Button>
        </form>
      ) : null}
      {confirmed ? (
        <section className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Regenerar revoca todos los códigos anteriores que no hayas usado.
          </p>
          <form action={regenerateAction}>
            <Button type="submit" variant="outline" disabled={regenerating}>
              {regenerating ? "Generando…" : "Regenerar códigos de recuperación"}
            </Button>
          </form>
          <FormMessage state={regenerated} />
        </section>
      ) : null}
    </div>
  );
}
