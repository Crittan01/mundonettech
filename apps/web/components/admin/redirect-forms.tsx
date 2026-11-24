"use client";

import type { UrlRedirect } from "@mundonettech/db";
import { useActionState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
}: {
  values?: Record<string, string> | undefined;
  redirect?: Pick<UrlRedirect, "id" | "fromPath" | "toPath" | "statusCode" | "active">;
  prefix: string;
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
          key={`${prefix}-from-${fromPath}`}
          id={`${prefix}-from`}
          name="fromPath"
          defaultValue={fromPath}
          required
          maxLength={2048}
          className={inputClass}
          placeholder="/ruta-anterior"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-to`}>Ruta de destino</Label>
        <Input
          key={`${prefix}-to-${toPath}`}
          id={`${prefix}-to`}
          name="toPath"
          defaultValue={toPath}
          required
          maxLength={2048}
          className={inputClass}
          placeholder="/ruta-vigente"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-status`}>Estado HTTP</Label>
        <select
          key={`${prefix}-status-${statusCode}`}
          id={`${prefix}-status`}
          name="statusCode"
          defaultValue={statusCode}
          className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="308">308 · Permanente</option>
          <option value="301">301 · Permanente legacy</option>
          <option value="307">307 · Temporal</option>
          <option value="302">302 · Temporal legacy</option>
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-active`}>Estado editorial</Label>
        <select
          key={`${prefix}-active-${String(active)}`}
          id={`${prefix}-active`}
          name="active"
          defaultValue={String(active)}
          className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="true">Activa</option>
          <option value="false">Inactiva</option>
        </select>
      </div>
    </div>
  );
}

function StatefulForm({
  action,
  children,
  submitLabel,
  className = "space-y-4",
}: {
  action: ServerAction;
  children: (values?: Record<string, string>) => React.ReactNode;
  submitLabel: string;
  className?: string;
}) {
  const [state, run, pending] = useActionState(action, initialActionState);
  return (
    <form action={run} className={className}>
      {children(state.values)}
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Procesando…" : submitLabel}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function CreateRedirectForm() {
  return (
    <StatefulForm action={createUrlRedirectAction} submitLabel="Crear redirección">
      {(values) => <Fields values={values} prefix="redirect-new" />}
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
        {(values) => (
          <>
            <input type="hidden" name="redirectId" value={redirect.id} />
            <Fields values={values} redirect={redirect} prefix={`redirect-${redirect.id}`} />
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
