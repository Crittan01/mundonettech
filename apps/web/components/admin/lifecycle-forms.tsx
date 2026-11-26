"use client";

import { startTransition, useActionState, useState } from "react";

import type { LifecycleStepInput } from "@mundonettech/core";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { initialActionState } from "@/lib/action-state";
import {
  createJourneyAction,
  transitionJourneyAction,
  updateJourneyAction,
} from "@/lib/actions/admin-lifecycle";

const firstStep: LifecycleStepInput = {
  position: 0,
  offsetMinutes: 0,
  subject: "Te damos la bienvenida a {{storeName}}",
  htmlBody:
    '<p>Hola {{customerFirstName}}. Queremos ayudarte a encontrar tu próxima tecnología en {{storeName}}.</p><p><a href="{{accountUrl}}">Visitar mi cuenta</a></p><p><a href="{{unsubscribeUrl}}">Dejar de recibir comunicaciones comerciales</a></p>',
  textBody:
    "Hola {{customerFirstName}}. Queremos ayudarte a encontrar tu próxima tecnología en {{storeName}}. Cuenta: {{accountUrl}}. Baja: {{unsubscribeUrl}}",
  variables: ["accountUrl", "customerFirstName", "storeName", "unsubscribeUrl"],
};

function variables(step: Pick<LifecycleStepInput, "subject" | "htmlBody" | "textBody">): string[] {
  return [
    ...new Set(
      [step.subject, step.htmlBody, step.textBody].flatMap((body) =>
        [...body.matchAll(/\{\{([a-zA-Z][a-zA-Z0-9]{0,59})\}\}/g)].map((match) => match[1]!),
      ),
    ),
  ].sort();
}

function serialized(steps: readonly LifecycleStepInput[]): string {
  return JSON.stringify(
    steps.map((step, position) => ({ ...step, position, variables: variables(step) })),
  );
}

export function JourneyEditorForm({
  journey,
  segments,
}: {
  journey?: {
    id: string;
    name: string;
    description: string | null;
    segmentId: string;
    version: number;
    steps: LifecycleStepInput[];
  };
  segments: Array<{ id: string; name: string; status: string }>;
}) {
  const [state, action, pending] = useActionState(
    journey ? updateJourneyAction : createJourneyAction,
    initialActionState,
  );
  const [steps, setSteps] = useState<LifecycleStepInput[]>(journey?.steps ?? [firstStep]);
  const prefix = journey ? `journey-${journey.id}` : "journey-new";
  const selectableSegments = segments.filter(
    (segment) => segment.status !== "ARCHIVED" || segment.id === journey?.segmentId,
  );
  const update = (index: number, patch: Partial<LifecycleStepInput>) => {
    setSteps((current) =>
      current.map((step, candidate) => (candidate === index ? { ...step, ...patch } : step)),
    );
  };
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
      {journey ? (
        <>
          <input type="hidden" name="journeyId" value={journey.id} />
          <input type="hidden" name="expectedVersion" value={journey.version} />
        </>
      ) : null}
      <input type="hidden" name="stepsJson" value={serialized(steps)} readOnly />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-name`}>Nombre</Label>
          <Input
            id={`${prefix}-name`}
            name="name"
            required
            minLength={2}
            maxLength={120}
            defaultValue={state.values?.name ?? journey?.name ?? ""}
            disabled={pending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-segment`}>Segmento de entrada</Label>
          <Select
            id={`${prefix}-segment`}
            name="segmentId"
            required
            defaultValue={state.values?.segmentId ?? journey?.segmentId ?? ""}
            disabled={pending}
          >
            <option value="" disabled>
              Selecciona un segmento
            </option>
            {selectableSegments.map((segment) => (
              <option key={segment.id} value={segment.id} disabled={segment.status === "ARCHIVED"}>
                {segment.name}
                {segment.status === "ACTIVE"
                  ? ""
                  : segment.status === "DRAFT"
                    ? " (borrador; actívalo antes del recorrido)"
                    : " (archivado; selecciona un segmento activo)"}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-description`}>Objetivo del journey</Label>
        <Textarea
          id={`${prefix}-description`}
          name="description"
          maxLength={500}
          defaultValue={state.values?.description ?? journey?.description ?? ""}
          disabled={pending}
        />
      </div>
      <div className="space-y-4">
        <div>
          <h3 className="font-semibold">Pasos y contenido</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Variables permitidas: <code>{"{{storeName}}"}</code>,{" "}
            <code>{"{{customerFirstName}}"}</code>, <code>{"{{accountUrl}}"}</code> y{" "}
            <code>{"{{unsubscribeUrl}}"}</code>. El enlace de baja es obligatorio.
          </p>
        </div>
        {steps.map((step, index) => {
          const id = `${prefix}-step-${index}`;
          return (
            <fieldset key={id} className="space-y-4 rounded-xl border border-border p-4">
              <legend className="px-1 font-medium">Paso {index + 1}</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor={`${id}-offset`}>Minutos desde la inscripción</Label>
                  <Input
                    id={`${id}-offset`}
                    type="number"
                    min={index === 0 ? 0 : 1}
                    max={525600}
                    step={1}
                    required
                    disabled={pending}
                    value={step.offsetMinutes}
                    onChange={(event) => {
                      const raw = event.currentTarget.value;
                      const parsedOffset = raw === "" ? 0 : Number(raw);
                      if (Number.isFinite(parsedOffset)) {
                        update(index, { offsetMinutes: Math.trunc(parsedOffset) });
                      }
                    }}
                  />
                </div>
                <div className="flex items-end justify-end">
                  {steps.length > 1 ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        setSteps((current) =>
                          current.filter((_step, candidate) => candidate !== index),
                        )
                      }
                    >
                      Eliminar paso
                    </Button>
                  ) : null}
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${id}-subject`}>Asunto</Label>
                <Input
                  id={`${id}-subject`}
                  required
                  maxLength={200}
                  disabled={pending}
                  value={step.subject}
                  onChange={(event) => update(index, { subject: event.currentTarget.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${id}-html`}>Cuerpo HTML</Label>
                <Textarea
                  id={`${id}-html`}
                  required
                  rows={7}
                  maxLength={50000}
                  disabled={pending}
                  value={step.htmlBody}
                  onChange={(event) => update(index, { htmlBody: event.currentTarget.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${id}-text`}>Versión de texto</Label>
                <Textarea
                  id={`${id}-text`}
                  required
                  rows={5}
                  maxLength={20000}
                  disabled={pending}
                  value={step.textBody}
                  onChange={(event) => update(index, { textBody: event.currentTarget.value })}
                />
              </div>
            </fieldset>
          );
        })}
        <Button
          type="button"
          variant="outline"
          disabled={
            pending || steps.length >= 20 || steps[steps.length - 1]!.offsetMinutes >= 525600
          }
          onClick={() =>
            setSteps((current) => [
              ...current,
              {
                ...firstStep,
                position: current.length,
                offsetMinutes: Math.min(525600, current[current.length - 1]!.offsetMinutes + 1440),
              },
            ])
          }
        >
          Añadir paso
        </Button>
      </div>
      <Button
        type="submit"
        disabled={
          pending || selectableSegments.filter((item) => item.status !== "ARCHIVED").length === 0
        }
      >
        {pending ? "Guardando…" : journey ? "Actualizar borrador" : "Crear journey"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function JourneyStateButtons({
  journey,
}: {
  journey: {
    id: string;
    version: number;
    status: "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED";
  };
}) {
  const [state, action, pending] = useActionState(transitionJourneyAction, initialActionState);
  const actions =
    journey.status === "DRAFT"
      ? [{ action: "ACTIVATE", label: "Activar y sellar" }]
      : journey.status === "ACTIVE"
        ? [{ action: "PAUSE", label: "Pausar envíos" }]
        : journey.status === "PAUSED"
          ? [{ action: "RESUME", label: "Reanudar envíos" }]
          : [];
  return (
    <div className="space-y-3">
      {journey.status !== "ARCHIVED" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) return;
            const submitter = (event.nativeEvent as SubmitEvent).submitter;
            const formData = new FormData(event.currentTarget);
            if (
              (submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement) &&
              submitter.name
            ) {
              formData.append(submitter.name, submitter.value);
            }
            startTransition(() => action(formData));
          }}
          aria-busy={pending}
          className="flex flex-wrap gap-2"
        >
          <input type="hidden" name="journeyId" value={journey.id} />
          <input type="hidden" name="expectedVersion" value={journey.version} />
          {actions.map((item) => (
            <Button
              key={item.action}
              type="submit"
              name="action"
              value={item.action}
              disabled={pending}
            >
              {item.label}
            </Button>
          ))}
          <Button type="submit" name="action" value="ARCHIVE" variant="outline" disabled={pending}>
            Archivar recorrido
          </Button>
        </form>
      ) : null}
      <FormMessage state={state} />
    </div>
  );
}
