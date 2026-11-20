"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { TurnstileField } from "@/components/auth/turnstile-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { initialActionState } from "@/lib/action-state";
import {
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

function EmailInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
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
      />
    </div>
  );
}

function PasswordFields() {
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
          aria-describedby="password-help"
        />
        <p id="password-help" className="text-xs leading-5 text-muted-foreground">
          Usa 12 a 128 caracteres, con mayúscula, minúscula, número y símbolo.
        </p>
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
    </>
  );
}

export function RegistrationForm({ siteKey, nonce }: SecurityProps) {
  const [state, action, pending] = useActionState(registerCustomerAction, initialActionState);
  const [email, setEmail] = useState("");
  return (
    <form action={action} className="space-y-5">
      <EmailInput value={email} onChange={setEmail} />
      <PasswordFields />
      <TurnstileField siteKey={siteKey} nonce={nonce} action="customer_register" state={state} />
      <FormMessage state={state} />
      {state.status === "success" ? (
        <Link
          className="block text-sm font-medium text-primary underline"
          href={`/verificar-correo?mode=signup&email=${encodeURIComponent(email)}`}
        >
          Ingresar el código
        </Link>
      ) : null}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Enviando solicitud…" : "Crear cuenta"}
      </Button>
    </form>
  );
}

export function CustomerLoginForm({ siteKey, nonce }: SecurityProps) {
  const [state, action, pending] = useActionState(requestCustomerOtpAction, initialActionState);
  const [email, setEmail] = useState("");
  return (
    <form action={action} className="space-y-5">
      <EmailInput value={email} onChange={setEmail} />
      <TurnstileField siteKey={siteKey} nonce={nonce} action="customer_login" state={state} />
      <FormMessage state={state} />
      {state.status === "success" ? (
        <Link
          className="block text-sm font-medium text-primary underline"
          href={`/verificar-correo?mode=email&email=${encodeURIComponent(email)}`}
        >
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
      <EmailInput value={email} onChange={setEmail} />
      <TurnstileField siteKey={siteKey} nonce={nonce} action="customer_recovery" state={state} />
      <FormMessage state={state} />
      {state.status === "success" ? (
        <Link
          className="block text-sm font-medium text-primary underline"
          href={`/recuperar?code=1&email=${encodeURIComponent(email)}`}
        >
          Ingresar código y nueva contraseña
        </Link>
      ) : null}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Enviando solicitud…" : "Solicitar recuperación"}
      </Button>
    </form>
  );
}

export function OtpVerificationForm({
  siteKey,
  nonce,
  defaultEmail,
  mode,
}: SecurityProps & { defaultEmail: string; mode: "signup" | "email" }) {
  const [state, action, pending] = useActionState(verifyCustomerOtpAction, initialActionState);
  const [email, setEmail] = useState(defaultEmail);
  return (
    <form action={action} className="space-y-5">
      <EmailInput value={email} onChange={setEmail} />
      <input type="hidden" name="mode" value={mode} />
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
  );
}

export function PasswordResetForm({
  siteKey,
  nonce,
  defaultEmail,
}: SecurityProps & { defaultEmail: string }) {
  const [state, action, pending] = useActionState(resetCustomerPasswordAction, initialActionState);
  const [email, setEmail] = useState(defaultEmail);
  return (
    <form action={action} className="space-y-5">
      <EmailInput value={email} onChange={setEmail} />
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
      <PasswordFields />
      <TurnstileField siteKey={siteKey} nonce={nonce} action="customer_reset" state={state} />
      <FormMessage state={state} />
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Actualizando…" : "Actualizar contraseña e ingresar"}
      </Button>
    </form>
  );
}
