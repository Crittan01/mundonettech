"use client";

import type { UrlRedirect } from "@mundonettech/db";
import { startTransition, useActionState, useEffect, useRef } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  archiveUrlRedirectAction,
  createUrlRedirectAction,
  setUrlRedirectActiveAction,
  updateUrlRedirectAction,
} from "@/lib/actions/admin-redirects";
import { initialActionState, type ActionState } from "@/lib/action-state";

type ServerAction = (previous: ActionState, formData: FormData) => Promise<ActionState>;
const inputClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm";

function Fields({
  values,
  redirect,
  prefix,
  disabled = false,
}: {
  values?: Record<string, string> | undefined;
  redirect?: Pick<UrlRedirect, "id" | "fromPath" | "toPath" | "statusCode" | "active">;
  prefix: string;
  disabled?: boolean;
}) {
  const fromPath = values?.fromPath ?? redirect?.fromPath ?? "";
  const toPath = values?.toPath ?? redirect?.toPath ?? "";
  const statusCode = values?.statusCode ?? String(redirect?.statusCode ?? 308);
  const active = values?.active ? values.active !== "false" : (redirect?.active ?? true);
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1fr_160px_140px]">
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-from`}>Ruta de origen</Label>
        <Input
          id={`${prefix}-from`}
          name="fromPath"
          defaultValue={fromPath}
          required
          disabled={disabled}
          maxLength={2048}
          className={inputClass}
          placeholder="/ruta-anterior"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-to`}>Ruta de destino</Label>
        <Input
          id={`${prefix}-to`}
          name="toPath"
          defaultValue={toPath}
          required
          disabled={disabled}
          maxLength={2048}
          className={inputClass}
          placeholder="/ruta-vigente"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-status`}>Estado HTTP</Label>
        <Select
          id={`${prefix}-status`}
          name="statusCode"
          defaultValue={statusCode}
          disabled={disabled}
        >
          <option value="308">308 · Permanente</option>
          <option value="301">301 · Permanente clásico</option>
          <option value="307">307 · Temporal</option>
          <option value="302">302 · Temporal clásico</option>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-active`}>Estado editorial</Label>
        <Select
          id={`${prefix}-active`}
          name="active"
          defaultValue={String(active)}
          disabled={disabled}
        >
          <option value="true">Activa</option>
          <option value="false">Inactiva</option>
        </Select>
      </div>
    </div>
  );
}

function StatefulForm({
  action,
  children,
  submitLabel,
  resetOnSuccess = false,
  className = "space-y-4",
}: {
  action: ServerAction;
  children: (values: Record<string, string> | undefined, pending: boolean) => React.ReactNode;
  submitLabel: string;
  resetOnSuccess?: boolean;
  className?: string;
}) {
  const [state, run, pending] = useActionState(action, initialActionState);
  const formRef = useRef<HTMLFormElement>(null);
  const handledSuccess = useRef<ActionState | null>(null);
  useEffect(() => {
    if (resetOnSuccess && state.status === "success" && handledSuccess.current !== state) {
      handledSuccess.current = state;
      formRef.current?.reset();
    }
  }, [resetOnSuccess, state]);
  return (
    <form
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const formData = new FormData(event.currentTarget);
        startTransition(() => run(formData));
      }}
      aria-busy={pending}
      className={className}
    >
      {children(state.values, pending)}
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Procesando…" : submitLabel}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function CreateRedirectForm() {
  return (
    <StatefulForm action={createUrlRedirectAction} submitLabel="Crear redirección" resetOnSuccess>
      {(values, pending) => <Fields values={values} prefix="redirect-new" disabled={pending} />}
    </StatefulForm>
  );
}

export function EditRedirectForm({
  redirect,
}: {
  redirect: Pick<UrlRedirect, "id" | "fromPath" | "toPath" | "statusCode" | "active">;
}) {
  return (
    <div className="space-y-3">
      <StatefulForm action={updateUrlRedirectAction} submitLabel="Guardar cambios">
        {(values, pending) => (
          <>
            <input type="hidden" name="redirectId" value={redirect.id} />
            <Fields
              values={values}
              redirect={redirect}
              prefix={`redirect-${redirect.id}`}
              disabled={pending}
            />
          </>
        )}
      </StatefulForm>
      <div className="flex flex-wrap gap-3">
        <StatefulForm
          action={setUrlRedirectActiveAction}
          submitLabel={redirect.active ? "Desactivar" : "Activar"}
        >
          {() => (
            <>
              <input type="hidden" name="redirectId" value={redirect.id} />
              <input type="hidden" name="active" value={String(!redirect.active)} />
            </>
          )}
        </StatefulForm>
        <StatefulForm action={archiveUrlRedirectAction} submitLabel="Archivar">
          {() => <input type="hidden" name="redirectId" value={redirect.id} />}
        </StatefulForm>
      </div>
    </div>
  );
}
