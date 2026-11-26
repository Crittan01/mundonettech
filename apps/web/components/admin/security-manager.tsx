"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useState } from "react";

import { RecoveryCodes } from "@/components/admin/admin-auth-forms";
import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { initialActionState, type ActionState } from "@/lib/action-state";
import {
  regenerateAdminRecoveryCodesAction,
  signOutAllAdminSessionsAction,
  stepUpAdminAction,
} from "@/lib/actions/admin-auth";
import { initialMfaState } from "@/lib/security/mfa-state";

export function StepUpPrompt({
  factorId,
  initialRemainingMs = 0,
}: {
  factorId: string;
  initialRemainingMs?: number;
}) {
  const router = useRouter();
  const codeId = useId();
  const [syncedRemainingMs, setSyncedRemainingMs] = useState(initialRemainingMs);
  const [expired, setExpired] = useState(initialRemainingMs <= 0);
  const [confirmedMessage, setConfirmedMessage] = useState<string | null>(null);
  const [windowCycle, setWindowCycle] = useState(0);

  if (syncedRemainingMs !== initialRemainingMs) {
    setSyncedRemainingMs(initialRemainingMs);
    if (windowCycle === 0) {
      setExpired(initialRemainingMs <= 0);
    }
  }

  useEffect(() => {
    if (expired) return;
    const waitMs = Math.max(1, windowCycle > 0 ? 600_000 : initialRemainingMs);
    const timer = window.setTimeout(() => {
      setConfirmedMessage(null);
      setExpired(true);
    }, waitMs);
    return () => window.clearTimeout(timer);
  }, [expired, initialRemainingMs, windowCycle]);

  const [stepUp, stepUpAction, stepping] = useActionState(
    async (prev: ActionState, formData: FormData) => {
      const result = await stepUpAdminAction(prev, formData);
      if (result.status === "success") {
        setConfirmedMessage(result.message ?? "Identidad confirmada por diez minutos.");
        setWindowCycle((value) => value + 1);
        setExpired(false);
        router.refresh();
      }
      return result;
    },
    initialActionState,
  );

  if (!expired) {
    if (!confirmedMessage) return null;
    return (
      <p
        className="rounded-lg border border-border bg-card p-4 text-sm text-foreground"
        role="status"
      >
        {confirmedMessage}
      </p>
    );
  }

  return (
    <form
      id="admin-step-up-prompt"
      action={stepUpAction}
      aria-busy={stepping}
      className="space-y-4 rounded-lg border border-border bg-card p-4"
    >
      <h2 className="font-semibold">Confirma tu identidad (step-up MFA)</h2>
      <p className="text-sm text-muted-foreground">
        Las acciones críticas exigen haber verificado tu autenticador en los últimos diez minutos.
      </p>
      <input type="hidden" name="factorId" value={factorId} />
      <div className="space-y-2">
        <Label htmlFor={codeId}>Código actual del autenticador</Label>
        <Input
          id={codeId}
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          disabled={stepping}
          className="max-w-xs"
        />
      </div>
      {stepUp.status === "error" ? <FormMessage state={stepUp} /> : null}
      <Button type="submit" disabled={stepping}>
        {stepping ? "Confirmando…" : "Confirmar identidad"}
      </Button>
    </form>
  );
}

export function SecurityManager({ factorId, recent }: { factorId: string; recent: boolean }) {
  const codeId = useId();
  const [stepUp, stepUpAction, stepping] = useActionState(stepUpAdminAction, initialActionState);
  const [regenerated, regenerateAction, regenerating] = useActionState(
    regenerateAdminRecoveryCodesAction,
    initialMfaState,
  );
  const [revokedAll, revokeAllAction, revokingAll] = useActionState(
    signOutAllAdminSessionsAction,
    initialActionState,
  );
  const confirmed = recent || stepUp.status === "success";
  if (regenerated.recoveryCodes) {
    return <RecoveryCodes codes={regenerated.recoveryCodes} returnHref="/admin/seguridad" />;
  }
  return (
    <div className="space-y-6">
      {!confirmed ? (
        <form
          action={stepUpAction}
          aria-busy={stepping}
          className="space-y-4 rounded-lg border border-border bg-card p-4"
        >
          <h2 className="font-semibold">Confirma tu identidad</h2>
          <p className="text-sm text-muted-foreground">
            Han pasado más de diez minutos desde tu último segundo factor.
          </p>
          <input type="hidden" name="factorId" value={factorId} />
          <div className="space-y-2">
            <Label htmlFor={codeId}>Código actual del autenticador</Label>
            <Input
              id={codeId}
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              disabled={stepping}
              className="max-w-xs"
            />
          </div>
          <FormMessage state={stepUp} />
          <Button type="submit" disabled={stepping}>
            {stepping ? "Confirmando…" : "Confirmar identidad"}
          </Button>
        </form>
      ) : stepUp.status === "success" ? (
        <FormMessage state={stepUp} />
      ) : null}
      <section className="space-y-3 rounded-xl border border-border bg-card p-5">
        <h2 className="text-lg font-semibold">Códigos de recuperación</h2>
        <p className="text-sm text-muted-foreground">
          Regenerar revoca todos los códigos anteriores que no hayas usado.
        </p>
        <form action={regenerateAction} aria-busy={regenerating}>
          <Button type="submit" variant="outline" disabled={!confirmed || regenerating}>
            {regenerating ? "Generando…" : "Regenerar códigos de recuperación"}
          </Button>
        </form>
        <FormMessage state={regenerated} />
      </section>
      <section className="space-y-3 rounded-xl border border-border bg-card p-5">
        <h2 className="text-lg font-semibold">Cerrar todas las sesiones</h2>
        <p className="text-sm text-muted-foreground">
          Exige un segundo factor reciente y revoca también las demás sesiones activas de tu cuenta.
        </p>
        <form action={revokeAllAction} aria-busy={revokingAll}>
          <Button variant="destructive" type="submit" disabled={!confirmed || revokingAll}>
            {revokingAll ? "Cerrando sesiones…" : "Cerrar todas las sesiones"}
          </Button>
        </form>
        <FormMessage state={revokedAll} />
      </section>
    </div>
  );
}
