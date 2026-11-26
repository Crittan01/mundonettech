"use client";

import { useRouter } from "next/navigation";
import {
  startTransition,
  useActionState,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

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

const STEP_UP_WINDOW_MS = 600_000;

interface ServerSyncSnapshot {
  readonly checkedAtMs: number | undefined;
  readonly initialRemainingMs: number;
}

function useStepUpDeadline({
  initialRemainingMs,
  checkedAtMs,
}: {
  initialRemainingMs: number;
  checkedAtMs?: number | undefined;
}) {
  const router = useRouter();
  const normalizedRemainingMs = Math.max(0, initialRemainingMs);
  const [expired, setExpired] = useState(() => normalizedRemainingMs <= 0);
  const [confirmedMessage, setConfirmedMessage] = useState<string | null>(null);
  const [localStepUpCycle, setLocalStepUpCycle] = useState(0);

  const deadlineMsRef = useRef<number | null>(null);
  const lastSyncRef = useRef<ServerSyncSnapshot | null>(null);
  const localStepUpAtMsRef = useRef<number | null>(null);
  const wasActiveRef = useRef(normalizedRemainingMs > 0);
  const expiryRefreshedRef = useRef(false);

  const markConfirmed = useCallback(
    (message: string) => {
      const now = Date.now();
      deadlineMsRef.current = now + STEP_UP_WINDOW_MS;
      localStepUpAtMsRef.current = now;
      wasActiveRef.current = true;
      expiryRefreshedRef.current = false;
      setConfirmedMessage(message);
      setExpired(false);
      setLocalStepUpCycle((cycle) => cycle + 1);
      router.refresh();
    },
    [router],
  );

  useEffect(() => {
    const now = Date.now();
    const prevSync = lastSyncRef.current;
    const syncChanged =
      prevSync === null ||
      prevSync.checkedAtMs !== checkedAtMs ||
      prevSync.initialRemainingMs !== normalizedRemainingMs;

    let timer: number | null = null;
    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const transitionToExpired = (triggerRefresh: boolean) => {
      clearTimer();
      deadlineMsRef.current = null;
      localStepUpAtMsRef.current = null;
      setConfirmedMessage(null);
      setExpired(true);
      if (triggerRefresh && wasActiveRef.current && !expiryRefreshedRef.current) {
        wasActiveRef.current = false;
        expiryRefreshedRef.current = true;
        router.refresh();
      } else {
        wasActiveRef.current = false;
      }
    };

    let syncTimer: number | null = null;
    const clearSyncTimer = () => {
      if (syncTimer !== null) {
        window.clearTimeout(syncTimer);
        syncTimer = null;
      }
    };

    if (syncChanged) {
      lastSyncRef.current = { checkedAtMs, initialRemainingMs: normalizedRemainingMs };

      if (normalizedRemainingMs <= 0) {
        const checkedAdvanced =
          checkedAtMs !== undefined &&
          prevSync?.checkedAtMs !== undefined &&
          checkedAtMs > prevSync.checkedAtMs;
        const decreasedToZero =
          prevSync !== null && prevSync.initialRemainingMs > 0 && normalizedRemainingMs <= 0;
        const newerAfterStepUp =
          localStepUpAtMsRef.current === null || checkedAdvanced || decreasedToZero;

        if (newerAfterStepUp) {
          syncTimer = window.setTimeout(() => transitionToExpired(false), 0);
          return () => {
            clearTimer();
            clearSyncTimer();
          };
        }
      } else {
        const serverDeadlineMs = now + normalizedRemainingMs;
        if (deadlineMsRef.current === null) {
          deadlineMsRef.current = serverDeadlineMs;
          wasActiveRef.current = true;
          expiryRefreshedRef.current = false;
          syncTimer = window.setTimeout(() => setExpired(false), 0);
        } else {
          deadlineMsRef.current = Math.min(deadlineMsRef.current, serverDeadlineMs);
          wasActiveRef.current = true;
        }
      }
    }

    const scheduleCheck = () => {
      clearTimer();
      const deadline = deadlineMsRef.current;
      if (deadline === null) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        transitionToExpired(true);
        return;
      }
      timer = window.setTimeout(
        () => {
          scheduleCheck();
        },
        Math.max(1, remaining),
      );
    };

    if (deadlineMsRef.current !== null) {
      scheduleCheck();
    }

    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === "hidden") return;
      scheduleCheck();
    };

    document.addEventListener("visibilitychange", handleVisibilityOrFocus);
    window.addEventListener("focus", handleVisibilityOrFocus);

    return () => {
      clearTimer();
      clearSyncTimer();
      document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
      window.removeEventListener("focus", handleVisibilityOrFocus);
    };
  }, [checkedAtMs, localStepUpCycle, normalizedRemainingMs, router]);

  return { expired, confirmedMessage, markConfirmed };
}

export function StepUpPrompt({
  factorId,
  initialRemainingMs = 0,
  checkedAtMs,
}: {
  factorId: string;
  initialRemainingMs?: number;
  checkedAtMs?: number;
}) {
  const codeId = useId();
  const { expired, confirmedMessage, markConfirmed } = useStepUpDeadline({
    initialRemainingMs,
    checkedAtMs,
  });

  const [stepUp, stepUpAction, stepping] = useActionState(
    async (prev: ActionState, formData: FormData) => {
      const result = await stepUpAdminAction(prev, formData);
      if (result.status === "success") {
        markConfirmed(result.message ?? "Identidad confirmada por diez minutos.");
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
      onSubmit={(event) => {
        event.preventDefault();
        if (stepping) return;
        const formData = new FormData(event.currentTarget);
        startTransition(() => stepUpAction(formData));
      }}
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

export function SecurityManager({
  factorId,
  recent,
  initialRemainingMs,
  checkedAtMs,
}: {
  factorId: string;
  recent: boolean;
  initialRemainingMs?: number;
  checkedAtMs?: number;
}) {
  const codeId = useId();
  const { expired, confirmedMessage, markConfirmed } = useStepUpDeadline({
    initialRemainingMs: initialRemainingMs ?? (recent ? STEP_UP_WINDOW_MS : 0),
    checkedAtMs,
  });
  const [stepUp, stepUpAction, stepping] = useActionState(
    async (prev: ActionState, formData: FormData) => {
      const result = await stepUpAdminAction(prev, formData);
      if (result.status === "success") {
        markConfirmed(result.message ?? "Identidad confirmada por diez minutos.");
      }
      return result;
    },
    initialActionState,
  );
  const [regenerated, regenerateAction, regenerating] = useActionState(
    regenerateAdminRecoveryCodesAction,
    initialMfaState,
  );
  const [revokedAll, revokeAllAction, revokingAll] = useActionState(
    signOutAllAdminSessionsAction,
    initialActionState,
  );
  const confirmed = !expired;
  if (regenerated.recoveryCodes) {
    return <RecoveryCodes codes={regenerated.recoveryCodes} returnHref="/admin/seguridad" />;
  }
  return (
    <div className="space-y-6">
      {!confirmed ? (
        <form
          id="admin-step-up-prompt"
          onSubmit={(event) => {
            event.preventDefault();
            if (stepping) return;
            const formData = new FormData(event.currentTarget);
            startTransition(() => stepUpAction(formData));
          }}
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
          {stepUp.status === "error" ? <FormMessage state={stepUp} /> : null}
          <Button type="submit" disabled={stepping}>
            {stepping ? "Confirmando…" : "Confirmar identidad"}
          </Button>
        </form>
      ) : confirmedMessage ? (
        <p
          className="rounded-lg border border-border bg-card p-4 text-sm text-foreground"
          role="status"
        >
          {confirmedMessage}
        </p>
      ) : null}
      <section className="space-y-3 rounded-xl border border-border bg-card p-5">
        <h2 className="text-lg font-semibold">Códigos de recuperación</h2>
        <p className="text-sm text-muted-foreground">
          Regenerar revoca todos los códigos anteriores que no hayas usado.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (regenerating || !confirmed) return;
            startTransition(() => regenerateAction());
          }}
          aria-busy={regenerating}
        >
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
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (revokingAll || !confirmed) return;
            startTransition(() => revokeAllAction());
          }}
          aria-busy={revokingAll}
        >
          <Button variant="destructive" type="submit" disabled={!confirmed || revokingAll}>
            {revokingAll ? "Cerrando sesiones…" : "Cerrar todas las sesiones"}
          </Button>
        </form>
        <FormMessage state={revokedAll} />
      </section>
    </div>
  );
}
