"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { FieldErrors, FormMessage } from "@/components/auth/form-message";
import { TurnstileField } from "@/components/auth/turnstile-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { initialActionState, type ActionState } from "@/lib/action-state";
import {
  cancelCustomerAuthRequestAction,
  registerCustomerAction,
  requestCustomerOtpAction,
  requestCustomerRecoveryAction,
  resetCustomerPasswordAction,
  verifyCustomerOtpAction,
} from "@/lib/actions/customer-auth";

interface SecurityProps {
  siteKey: string;
  nonce: string;
}

function EmailInput({
  value,
  onChange,
  state,
  errorId,
}: {
  value: string;
  onChange: (value: string) => void;
  state: ActionState;
  errorId: string;
}) {
  const errors = state.fieldErrors?.email;
  return (
    <div className="space-y-2">
      <Label htmlFor="email">Correo electrónico</Label>
      <Input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        maxLength={320}
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={errors?.length ? errorId : undefined}
        aria-invalid={errors?.length ? true : undefined}
      />
      <FieldErrors id={errorId} messages={errors} />
    </div>
  );
}

function PasswordFields({ state, idPrefix }: { state: ActionState; idPrefix: string }) {
  const passwordErrors = state.fieldErrors?.password;
  const confirmationErrors = state.fieldErrors?.confirmation;
  const passwordHelpId = `${idPrefix}-password-help`;
  const passwordErrorId = `${idPrefix}-password-error`;
  const confirmationErrorId = `${idPrefix}-confirmation-error`;
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="password">Contraseña</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
          aria-describedby={`${passwordHelpId}${passwordErrors?.length ? ` ${passwordErrorId}` : ""}`}
          aria-invalid={passwordErrors?.length ? true : undefined}
        />
        <p id={passwordHelpId} className="text-xs leading-5 text-muted-foreground">
          Usa 12 a 128 caracteres, con mayúscula, minúscula, número y símbolo.
        </p>
        <FieldErrors id={passwordErrorId} messages={passwordErrors} />
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
          aria-describedby={confirmationErrors?.length ? confirmationErrorId : undefined}
          aria-invalid={confirmationErrors?.length ? true : undefined}
        />
        <FieldErrors id={confirmationErrorId} messages={confirmationErrors} />
      </div>
    </>
  );
}

function CancelRequestForm() {
  return (
    <form action={cancelCustomerAuthRequestAction}>
      <Button type="submit" variant="outline" className="w-full">
        Cancelar solicitud
      </Button>
    </form>
  );
}

export function RegistrationForm({ siteKey, nonce }: SecurityProps) {
  const [state, action, pending] = useActionState(registerCustomerAction, initialActionState);
  const [email, setEmail] = useState("");
  return (
    <form action={action} className="space-y-5">
      <EmailInput
        value={email}
        onChange={setEmail}
        state={state}
        errorId="registration-email-error"
      />
      <PasswordFields state={state} idPrefix="registration" />
      <TurnstileField siteKey={siteKey} nonce={nonce} action="customer_register" state={state} />
      <FormMessage state={state} />
      {state.status === "success" ? (
        <Link className="block text-sm font-medium text-primary underline" href="/verificar-correo">
          Ingresar el código
        </Link>
      ) : null}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Enviando solicitud…" : "Crear cuenta"}
      </Button>
    </form>
  );
}

export function CustomerLoginForm({
  siteKey,
  nonce,
  next,
}: SecurityProps & { next: string | null }) {
  const [state, action, pending] = useActionState(requestCustomerOtpAction, initialActionState);
  const [email, setEmail] = useState("");
  return (
    <form action={action} className="space-y-5">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <EmailInput value={email} onChange={setEmail} state={state} errorId="login-email-error" />
      <TurnstileField siteKey={siteKey} nonce={nonce} action="customer_login" state={state} />
      <FormMessage state={state} />
      {state.status === "success" ? (
        <Link className="block text-sm font-medium text-primary underline" href="/verificar-correo">
          Ingresar el código
        </Link>
      ) : null}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Enviando código…" : "Enviar código de acceso"}
      </Button>
    </form>
  );
}

export function RecoveryRequestForm({ siteKey, nonce }: SecurityProps) {
  const [state, action, pending] = useActionState(
    requestCustomerRecoveryAction,
    initialActionState,
  );
  const [email, setEmail] = useState("");
  return (
    <form action={action} className="space-y-5">
      <EmailInput
        value={email}
        onChange={setEmail}
        state={state}
        errorId="recovery-request-email-error"
      />
      <TurnstileField siteKey={siteKey} nonce={nonce} action="customer_recovery" state={state} />
      <FormMessage state={state} />
      {state.status === "success" ? (
        <Link className="block text-sm font-medium text-primary underline" href="/recuperar?code=1">
          Ingresar código y nueva contraseña
        </Link>
      ) : null}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Enviando solicitud…" : "Solicitar recuperación"}
      </Button>
    </form>
  );
}

export function OtpVerificationForm({ siteKey, nonce }: SecurityProps) {
  const [state, action, pending] = useActionState(verifyCustomerOtpAction, initialActionState);
  return (
    <div className="space-y-3">
      <form action={action} className="space-y-5">
        <p className="text-sm text-muted-foreground">
          Ingresa el código enviado al correo asociado a esta solicitud. El correo queda protegido
          por una cookie cifrada y no se incluye en el enlace.
        </p>
        <div className="space-y-2">
          <Label htmlFor="code">Código de seis dígitos</Label>
          <Input
            id="code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            className="text-center text-2xl tracking-[0.4em]"
          />
        </div>
        <TurnstileField siteKey={siteKey} nonce={nonce} action="customer_verify" state={state} />
        <FormMessage state={state} />
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Verificando…" : "Verificar código"}
        </Button>
      </form>
      <CancelRequestForm />
    </div>
  );
}

export function PasswordResetForm({ siteKey, nonce }: SecurityProps) {
  const [state, action, pending] = useActionState(resetCustomerPasswordAction, initialActionState);
  return (
    <div className="space-y-3">
      <form action={action} className="space-y-5">
        <p className="text-sm text-muted-foreground">
          El correo de recuperación permanece en una cookie cifrada, HttpOnly y con vencimiento de
          diez minutos.
        </p>
        <div className="space-y-2">
          <Label htmlFor="code">Código de recuperación</Label>
          <Input
            id="code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
          />
        </div>
        <PasswordFields state={state} idPrefix="recovery-reset" />
        <TurnstileField siteKey={siteKey} nonce={nonce} action="customer_reset" state={state} />
        <FormMessage state={state} />
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Actualizando…" : "Actualizar contraseña e ingresar"}
        </Button>
      </form>
      <CancelRequestForm />
    </div>
  );
}
