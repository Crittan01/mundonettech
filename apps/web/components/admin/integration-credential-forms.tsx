"use client";

import { startTransition, useActionState, useRef, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createWompiCredentialAction,
  reencryptCredentialAction,
  revokeCredentialAction,
  rotateWompiCredentialAction,
} from "@/lib/actions/admin-integrations";
import { initialActionState } from "@/lib/action-state";

export interface IntegrationCredentialView {
  readonly id: string;
  readonly provider: string;
  readonly environment: string;
  readonly keyVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revokedAt: string | null;
}

const wizardSteps = ["Cuenta", "Secretos", "Revisión"] as const;

function SecretField({
  id,
  name,
  label,
  required = true,
}: {
  id: string;
  name: string;
  label: string;
  required?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        type="password"
        autoComplete="new-password"
        spellCheck={false}
        minLength={20}
        maxLength={255}
        required={required}
      />
    </div>
  );
}

export function WompiCredentialWizard({ environment }: { environment: string }) {
  const [state, action, pending] = useActionState(createWompiCredentialAction, initialActionState);
  const [step, setStep] = useState(1);
  const [dismissSuccess, setDismissSuccess] = useState(false);
  const sections = useRef<Record<number, HTMLFieldSetElement | null>>({});
  const form = useRef<HTMLFormElement>(null);
  const values = state.values;

  function continueForward() {
    const section = sections.current[step];
    if (!section) return;
    for (const control of section.querySelectorAll<HTMLInputElement>("input")) {
      if (!control.checkValidity()) {
        control.reportValidity();
        return;
      }
    }
    setStep((current) => Math.min(3, current + 1));
  }

  function advanceOrEncrypt() {
    if (step < 3) {
      continueForward();
      return;
    }
    const currentForm = form.current;
    if (!currentForm?.reportValidity()) return;
    startTransition(() => action(new FormData(currentForm)));
  }

  if (state.status === "success" && !dismissSuccess) {
    return (
      <div className="space-y-4 rounded-lg border border-success bg-card p-5">
        <FormMessage state={state} />
        <p className="text-sm text-muted-foreground">
          Los campos secretos se descartaron de esta vista. La credencial ya está disponible en el
          descriptor del ambiente.
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setDismissSuccess(true);
            setStep(1);
          }}
        >
          Conectar otra cuenta
        </Button>
      </div>
    );
  }

  return (
    <form
      ref={form}
      onSubmit={(event) => {
        event.preventDefault();
        if (step !== 3) return;
        startTransition(() => action(new FormData(event.currentTarget)));
      }}
      className="space-y-5"
      noValidate
    >
      <ol aria-label="Pasos para conectar Wompi" className="grid gap-2 sm:grid-cols-3">
        {wizardSteps.map((label, index) => {
          const number = index + 1;
          return (
            <li
              key={label}
              className="rounded-lg border border-border p-3 text-sm aria-current:border-primary aria-current:text-primary"
              aria-current={step === number ? "step" : undefined}
            >
              Paso {number}: {label}
            </li>
          );
        })}
      </ol>
      <fieldset
        ref={(node) => {
          sections.current[1] = node;
        }}
        hidden={step !== 1}
        className="space-y-4"
      >
        <legend className="mb-3 font-semibold">Identidad de la cuenta</legend>
        <div className="space-y-2">
          <Label htmlFor="wompi-account">Nombre operativo de la cuenta</Label>
          <Input
            id="wompi-account"
            name="accountName"
            defaultValue={values?.accountName ?? ""}
            maxLength={120}
            required
          />
          <p className="text-xs text-muted-foreground">
            Identifica esta cuenta sin incluir correos, NIT, nombres de personas ni secretos.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="wompi-public-key">Llave pública Wompi</Label>
          <Input
            id="wompi-public-key"
            name="publicKey"
            defaultValue={values?.publicKey ?? ""}
            autoComplete="off"
            spellCheck={false}
            minLength={20}
            maxLength={255}
            required
          />
        </div>
        <p className="rounded-lg bg-secondary/50 p-3 text-sm text-muted-foreground">
          Ambiente aislado: <strong>{environment}</strong>. Las llaves de prueba no se aceptan en
          PRD y las llaves productivas no se aceptan en LOCAL o STG.
        </p>
      </fieldset>
      <fieldset
        ref={(node) => {
          sections.current[2] = node;
        }}
        hidden={step !== 2}
        className="space-y-4"
      >
        <legend className="mb-3 font-semibold">Material secreto</legend>
        <SecretField id="wompi-private-key" name="privateKey" label="Llave privada Wompi" />
        <SecretField id="wompi-integrity" name="integritySecret" label="Secreto de integridad" />
        <SecretField id="wompi-events" name="eventsSecret" label="Secreto de eventos" />
        <p className="text-xs text-muted-foreground">
          Estos tres valores se cifran con AES-256-GCM antes de persistirse. Nunca se muestran de
          nuevo ni se incluyen en descriptores o auditoría.
        </p>
      </fieldset>
      <fieldset
        ref={(node) => {
          sections.current[3] = node;
        }}
        hidden={step !== 3}
        className="space-y-4"
      >
        <legend className="mb-3 font-semibold">Revisión y cifrado</legend>
        <dl className="grid gap-3 rounded-lg bg-secondary/40 p-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Proveedor</dt>
            <dd className="font-medium">Wompi</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Ambiente</dt>
            <dd className="font-medium">{environment}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Secretos</dt>
            <dd className="font-medium">Llave privada, integridad y eventos listos para cifrar</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Protección</dt>
            <dd className="font-medium">AES-256-GCM · nonce único · AAD por cuenta y ambiente</dd>
          </div>
        </dl>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" required className="mt-1 size-4 accent-primary" />
          <span>Confirmo que las llaves pertenecen a la cuenta y al ambiente seleccionados.</span>
        </label>
      </fieldset>
      <FormMessage state={state} />
      <div className="flex flex-wrap justify-between gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={step === 1 || pending}
          onClick={() => setStep((current) => Math.max(1, current - 1))}
        >
          Anterior
        </Button>
        <Button type="button" onClick={advanceOrEncrypt} disabled={pending}>
          {step < 3 ? "Continuar" : pending ? "Cifrando…" : "Cifrar y guardar credencial"}
        </Button>
      </div>
    </form>
  );
}

export function CredentialRotationForm({ credential }: { credential: IntegrationCredentialView }) {
  const [state, action, pending] = useActionState(rotateWompiCredentialAction, initialActionState);
  const values = state.values;
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="credentialId" value={credential.id} />
      <div className="space-y-2">
        <Label htmlFor={`public-${credential.id}`}>Nueva llave pública</Label>
        <Input
          id={`public-${credential.id}`}
          name="publicKey"
          defaultValue={values?.publicKey ?? ""}
          minLength={20}
          maxLength={255}
          required
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <SecretField
          id={`private-${credential.id}`}
          name="privateKey"
          label="Nueva llave privada"
        />
        <SecretField
          id={`integrity-${credential.id}`}
          name="integritySecret"
          label="Nuevo secreto de integridad"
        />
        <SecretField
          id={`events-${credential.id}`}
          name="eventsSecret"
          label="Nuevo secreto de eventos"
        />
      </div>
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Rotando…" : "Rotar secretos"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function ReencryptCredentialForm({ credentialId }: { credentialId: string }) {
  const [state, action, pending] = useActionState(reencryptCredentialAction, initialActionState);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="credentialId" value={credentialId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        Recifrar con clave activa
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function RevokeCredentialForm({ credentialId }: { credentialId: string }) {
  const [state, action, pending] = useActionState(revokeCredentialAction, initialActionState);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="credentialId" value={credentialId} />
      <div className="space-y-2">
        <Label htmlFor={`confirmation-${credentialId}`}>Confirmación irreversible</Label>
        <Input
          id={`confirmation-${credentialId}`}
          name="confirmation"
          placeholder="Escribe REVOCAR"
          maxLength={7}
          required
        />
      </div>
      <Button type="submit" variant="destructive" size="sm" disabled={pending}>
        Revocar credencial
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
