"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

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
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  state: ActionState;
  errorId: string;
  disabled?: boolean;
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
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={errors?.length ? errorId : undefined}
        aria-invalid={errors?.length ? true : undefined}
      />
      <FieldErrors id={errorId} messages={errors} />
    </div>
  );
}

function PasswordFields({
  state,
  idPrefix,
  disabled,
}: {
  state: ActionState;
  idPrefix: string;
  disabled?: boolean;
}) {
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
          disabled={disabled}
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
          disabled={disabled}
          aria-describedby={confirmationErrors?.length ? confirmationErrorId : undefined}
          aria-invalid={confirmationErrors?.length ? true : undefined}
        />
        <FieldErrors id={confirmationErrorId} messages={confirmationErrors} />
      </div>
    </>
  );
}

function CancelRequestSubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant="outline"
      className="w-full"
      disabled={pending}
      aria-busy={pending}
    >
      {pending ? "Cancelando…" : "Cancelar solicitud"}
    </Button>
  );
}

function CancelRequestForm() {
  return (
    <form action={cancelCustomerAuthRequestAction}>
      <CancelRequestSubmitButton />
    </form>
  );
}

export function RegistrationForm({
  siteKey,
  nonce,
  next = null,
}: SecurityProps & { next?: string | null }) {
  const [state, action, pending] = useActionState(registerCustomerAction, initialActionState);
  const [email, setEmail] = useState("");
  return (
    <form action={action} className="space-y-5" aria-busy={pending}>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <EmailInput
        value={email}
        onChange={setEmail}
        state={state}
        errorId="registration-email-error"
        disabled={pending}
      />
      <PasswordFields state={state} idPrefix="registration" disabled={pending} />
      <TurnstileField siteKey={siteKey} nonce={nonce} action="customer_register" state={state} />
      <FormMessage state={state} />
      {state.status === "success" ? (
        <Button asChild variant="outline" className="w-full">
          <Link href="/verificar-correo">Ingresar el código</Link>
        </Button>
      ) : null}
      <Button type="submit" className="w-full" disabled={pending} aria-busy={pending}>
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
    <form action={action} className="space-y-5" aria-busy={pending}>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <EmailInput
        value={email}
        onChange={setEmail}
        state={state}
        errorId="login-email-error"
        disabled={pending}
      />
      <TurnstileField siteKey={siteKey} nonce={nonce} action="customer_login" state={state} />
      <FormMessage state={state} />
      {state.status === "success" ? (
        <Button asChild variant="outline" className="w-full">
          <Link href="/verificar-correo">Ingresar el código</Link>
        </Button>
      ) : null}
      <Button type="submit" className="w-full" disabled={pending} aria-busy={pending}>
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
    <form action={action} className="space-y-5" aria-busy={pending}>
      <EmailInput
        value={email}
        onChange={setEmail}
        state={state}
        errorId="recovery-request-email-error"
        disabled={pending}
      />
      <TurnstileField siteKey={siteKey} nonce={nonce} action="customer_recovery" state={state} />
      <FormMessage state={state} />
      {state.status === "success" ? (
        <Button asChild variant="outline" className="w-full">
          <Link href="/recuperar?code=1">Ingresar código y nueva contraseña</Link>
        </Button>
      ) : null}
      <Button type="submit" className="w-full" disabled={pending} aria-busy={pending}>
        {pending ? "Enviando solicitud…" : "Solicitar recuperación"}
      </Button>
    </form>
  );
}

export function OtpVerificationForm({ siteKey, nonce }: SecurityProps) {
  const [state, action, pending] = useActionState(verifyCustomerOtpAction, initialActionState);
  const [code, setCode] = useState("");
  const codeErrors = state.fieldErrors?.code;
  return (
    <div className="space-y-3">
      <form action={action} className="space-y-5" aria-busy={pending}>
        <p className="text-sm text-muted-foreground">
          Ingresa el código enviado al correo asociado a esta solicitud. Tu correo permanece
          protegido de forma privada y no se incluye en el enlace.
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
            disabled={pending}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            aria-invalid={codeErrors?.length ? true : undefined}
            aria-describedby={codeErrors?.length ? "otp-code-error" : undefined}
            className="text-center text-2xl tracking-[0.4em]"
          />
          <FieldErrors id="otp-code-error" messages={codeErrors} />
        </div>
        <TurnstileField siteKey={siteKey} nonce={nonce} action="customer_verify" state={state} />
        <FormMessage state={state} />
        <Button type="submit" className="w-full" disabled={pending} aria-busy={pending}>
          {pending ? "Verificando…" : "Verificar código"}
        </Button>
      </form>
      <CancelRequestForm />
    </div>
  );
}

export function PasswordResetForm({ siteKey, nonce }: SecurityProps) {
  const [state, action, pending] = useActionState(resetCustomerPasswordAction, initialActionState);
  const [code, setCode] = useState("");
  const codeErrors = state.fieldErrors?.code;
  return (
    <div className="space-y-3">
      <form action={action} className="space-y-5" aria-busy={pending}>
        <p className="text-sm text-muted-foreground">
          Tu correo de recuperación permanece protegido de forma privada y con vencimiento de diez
          minutos mientras defines tu nueva contraseña.
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
            disabled={pending}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            aria-invalid={codeErrors?.length ? true : undefined}
            aria-describedby={codeErrors?.length ? "reset-code-error" : undefined}
          />
          <FieldErrors id="reset-code-error" messages={codeErrors} />
        </div>
        <PasswordFields state={state} idPrefix="recovery-reset" disabled={pending} />
        <TurnstileField siteKey={siteKey} nonce={nonce} action="customer_reset" state={state} />
        <FormMessage state={state} />
        <Button type="submit" className="w-full" disabled={pending} aria-busy={pending}>
          {pending ? "Actualizando…" : "Actualizar contraseña e ingresar"}
        </Button>
      </form>
      <CancelRequestForm />
    </div>
  );
}
