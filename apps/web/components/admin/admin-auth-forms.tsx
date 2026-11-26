"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useActionState, useEffect, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { TurnstileField } from "@/components/auth/turnstile-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { initialActionState } from "@/lib/action-state";
import {
  loginAdminAction,
  recoverAdminFactorAction,
  startAdminEnrollmentAction,
  verifyAdminMfaAction,
} from "@/lib/actions/admin-auth";
import { initialMfaState } from "@/lib/security/mfa-state";

interface SecurityProps {
  siteKey: string;
  nonce: string;
}

export function AdminLoginForm({ siteKey, nonce }: SecurityProps) {
  const [state, action, pending] = useActionState(loginAdminAction, initialActionState);
  const [email, setEmail] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const formData = new FormData(event.currentTarget);
        startTransition(() => action(formData));
      }}
      aria-busy={pending}
      className="space-y-5"
    >
      <div className="space-y-2">
        <Label htmlFor="email">Correo corporativo</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          maxLength={320}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={pending}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Contraseña</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={128}
          disabled={pending}
        />
      </div>
      <TurnstileField siteKey={siteKey} nonce={nonce} action="admin_login" state={state} />
      <FormMessage state={state} />
      <Button className="w-full" disabled={pending} type="submit">
        {pending ? "Verificando…" : "Continuar al segundo factor"}
      </Button>
    </form>
  );
}

export function RecoveryCodes({
  codes,
  returnHref = "/admin",
  onContinue,
}: {
  codes: readonly string[];
  returnHref?: string;
  onContinue?: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopyMessage("Códigos copiados.");
    } catch {
      setCopyMessage("No pudimos copiarlos. Selecciona y copia los códigos manualmente.");
    }
  }
  return (
    <section
      className="space-y-4 rounded-lg border border-border p-4"
      aria-labelledby="recovery-title"
    >
      <h2 id="recovery-title" className="font-semibold">
        Guarda tus códigos de recuperación
      </h2>
      <p className="text-sm text-muted-foreground">
        Se muestran solo esta vez. Cada uno sirve una vez para restablecer tu autenticador.
      </p>
      <ol className="grid gap-2 font-mono text-sm sm:grid-cols-2">
        {codes.map((code, index) => (
          <li key={code}>
            <span className="sr-only">Código {index + 1}: </span>
            <code>{code}</code>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={copy}>
          Copiar
        </Button>
        <Button type="button" variant="outline" onClick={() => window.print()}>
          Imprimir
        </Button>
      </div>
      {copyMessage ? (
        <p role="status" className="text-sm">
          {copyMessage}
        </p>
      ) : null}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1 size-4 shrink-0 accent-primary"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        Guardé los códigos en un lugar seguro.
      </label>
      {confirmed ? (
        onContinue ? (
          <Button type="button" onClick={onContinue}>
            Continuar al panel
          </Button>
        ) : (
          <Button asChild>
            <Link href={returnHref} prefetch={false}>
              Continuar al panel
            </Link>
          </Button>
        )
      ) : (
        <Button type="button" disabled>
          Continuar al panel
        </Button>
      )}
    </section>
  );
}

export function AdminMfaForm({
  siteKey,
  nonce,
  verifiedFactorId,
  canUseRecoveryCode,
}: SecurityProps & { verifiedFactorId: string | null; canUseRecoveryCode: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"totp" | "recovery">("totp");
  const [enrollment, enrollAction, enrolling] = useActionState(
    startAdminEnrollmentAction,
    initialMfaState,
  );
  const [recovery, recoveryAction, recovering] = useActionState(
    recoverAdminFactorAction,
    initialMfaState,
  );
  const [verification, verifyAction, verifying] = useActionState(
    verifyAdminMfaAction,
    initialMfaState,
  );
  const prepared = recovery.qrCode ? recovery : enrollment;
  const factorId = prepared.factorId ?? verifiedFactorId;

  useEffect(() => {
    if (verification.completed && !verification.recoveryCodes) router.replace("/admin");
  }, [verification, router]);

  if (verification.recoveryCodes) return <RecoveryCodes codes={verification.recoveryCodes} />;
  if (factorId)
    return (
      <div className="space-y-5">
        {prepared.qrCode ? (
          <div className="space-y-3 text-center">
            <Image
              unoptimized
              src={prepared.qrCode}
              width={240}
              height={240}
              alt="Código QR para tu aplicación autenticadora"
              className="mx-auto"
            />
            {prepared.secret ? (
              <p className="font-mono text-xs break-all text-muted-foreground">
                Clave manual: {prepared.secret}
              </p>
            ) : null}
          </div>
        ) : null}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (verifying) return;
            const formData = new FormData(event.currentTarget);
            startTransition(() => verifyAction(formData));
          }}
          aria-busy={verifying}
          className="space-y-5"
        >
          <input type="hidden" name="factorId" value={factorId} />
          <div className="space-y-2">
            <Label htmlFor="code">Código del autenticador</Label>
            <Input
              id="code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              disabled={verifying}
              className="text-center text-2xl tracking-[0.4em]"
            />
          </div>
          <FormMessage state={verification} />
          <Button className="w-full" type="submit" disabled={verifying}>
            {verifying ? "Verificando…" : "Verificar segundo factor"}
          </Button>
        </form>
        {canUseRecoveryCode ? (
          <button
            type="button"
            aria-expanded={mode === "recovery"}
            className="inline-flex min-h-11 items-center rounded-sm text-sm text-primary underline outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setMode(mode === "recovery" ? "totp" : "recovery")}
          >
            {mode === "recovery" ? "Volver al autenticador" : "Usar un código de recuperación"}
          </button>
        ) : null}
        {canUseRecoveryCode && mode === "recovery" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (recovering) return;
              const formData = new FormData(event.currentTarget);
              startTransition(() => recoveryAction(formData));
            }}
            aria-busy={recovering}
            className="space-y-3 border-t border-border pt-4"
          >
            <Label htmlFor="recoveryCode">Código de recuperación</Label>
            <Input
              id="recoveryCode"
              name="recoveryCode"
              autoComplete="off"
              required
              maxLength={40}
              disabled={recovering}
            />
            <TurnstileField
              siteKey={siteKey}
              nonce={nonce}
              action="admin_recovery"
              state={recovery}
            />
            <FormMessage state={recovery} />
            <Button type="submit" variant="outline" disabled={recovering}>
              {recovering ? "Comprobando…" : "Restablecer autenticador"}
            </Button>
          </form>
        ) : null}
      </div>
    );
  return (
    <div className="space-y-5">
      <p className="text-sm leading-6 text-muted-foreground">
        No tienes un autenticador verificado. Configúralo antes de entrar al panel.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (enrolling) return;
          startTransition(() => enrollAction());
        }}
        aria-busy={enrolling}
      >
        <Button type="submit" disabled={enrolling}>
          {enrolling ? "Preparando…" : "Configurar autenticador"}
        </Button>
      </form>
      <FormMessage state={enrollment} />
      {canUseRecoveryCode ? (
        <>
          <button
            type="button"
            aria-expanded={mode === "recovery"}
            className="inline-flex min-h-11 items-center rounded-sm text-sm text-primary underline outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setMode(mode === "recovery" ? "totp" : "recovery")}
          >
            {mode === "recovery" ? "Ocultar recuperación" : "Usar un código de recuperación"}
          </button>
          {mode === "recovery" ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (recovering) return;
                const formData = new FormData(event.currentTarget);
                startTransition(() => recoveryAction(formData));
              }}
              aria-busy={recovering}
              className="space-y-3 border-t border-border pt-4"
            >
              <Label htmlFor="recoveryCode">Código de recuperación</Label>
              <Input
                id="recoveryCode"
                name="recoveryCode"
                autoComplete="off"
                required
                maxLength={40}
                disabled={recovering}
              />
              <TurnstileField
                siteKey={siteKey}
                nonce={nonce}
                action="admin_recovery"
                state={recovery}
              />
              <FormMessage state={recovery} />
              <Button type="submit" variant="outline" disabled={recovering}>
                {recovering ? "Comprobando…" : "Restablecer autenticador"}
              </Button>
            </form>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
