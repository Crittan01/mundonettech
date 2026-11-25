"use client";

import { useActionState, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveEmailTemplateAction } from "@/lib/actions/admin-communications";
import { initialActionState } from "@/lib/action-state";

export interface EmailTemplateView {
  readonly subject: string;
  readonly htmlBody: string;
  readonly textBody: string;
  readonly variables: readonly string[];
}

export function EmailTemplateForm({
  templates,
  idempotencyKey,
}: {
  templates: Readonly<Record<string, EmailTemplateView>>;
  idempotencyKey: string;
}) {
  const keys = Object.keys(templates);
  const firstKey = keys[0]!;
  const [templateKey, setTemplateKey] = useState(firstKey);
  const [requestKey, setRequestKey] = useState(idempotencyKey);
  const [state, action, pending] = useActionState(
    async (previous: typeof initialActionState, formData: FormData) => {
      const result = await saveEmailTemplateAction(previous, formData);
      if (result.status === "success") setRequestKey(crypto.randomUUID());
      return result;
    },
    initialActionState,
  );
  const [useServerValues, setUseServerValues] = useState(false);
  const [subject, setSubject] = useState(templates[firstKey]!.subject);
  const [htmlBody, setHtmlBody] = useState(templates[firstKey]!.htmlBody);
  const [textBody, setTextBody] = useState(templates[firstKey]!.textBody);
  const [variables, setVariables] = useState(templates[firstKey]!.variables.join(","));
  const [publish, setPublish] = useState(true);
  const values = useServerValues ? state.values : undefined;
  const currentSubject = values?.subject ?? subject;
  const currentHtml = values?.htmlBody ?? htmlBody;
  const currentText = values?.textBody ?? textBody;
  const currentVariables = values?.variables ?? variables;
  function selectTemplate(key: string) {
    const template = templates[key]!;
    setUseServerValues(false);
    setTemplateKey(key);
    setSubject(template.subject);
    setHtmlBody(template.htmlBody);
    setTextBody(template.textBody);
    setVariables(template.variables.join(","));
  }
  return (
    <form action={action} className="space-y-4" onSubmit={() => setUseServerValues(true)}>
      <input type="hidden" name="idempotencyKey" value={requestKey} />
      <div className="space-y-2">
        <Label htmlFor="email-template-key">Tipo de comunicación</Label>
        <select
          id="email-template-key"
          name="templateKey"
          value={templateKey}
          onChange={(event) => selectTemplate(event.target.value)}
          className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          {keys.map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="email-template-subject">Asunto</Label>
        <Input
          id="email-template-subject"
          name="subject"
          value={currentSubject}
          onChange={(event) => {
            setUseServerValues(false);
            setSubject(event.target.value);
          }}
          maxLength={200}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="email-template-html">HTML permitido, sin scripts ni contenido activo</Label>
        <textarea
          id="email-template-html"
          name="htmlBody"
          value={currentHtml}
          onChange={(event) => {
            setUseServerValues(false);
            setHtmlBody(event.target.value);
          }}
          rows={10}
          maxLength={200_000}
          className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="email-template-text">Versión de texto</Label>
        <textarea
          id="email-template-text"
          name="textBody"
          value={currentText}
          onChange={(event) => {
            setUseServerValues(false);
            setTextBody(event.target.value);
          }}
          rows={6}
          maxLength={100_000}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="email-template-variables">Variables usadas, separadas por coma</Label>
        <Input
          id="email-template-variables"
          name="variables"
          value={currentVariables}
          onChange={(event) => {
            setUseServerValues(false);
            setVariables(event.target.value);
          }}
          required
        />
        <p className="text-xs text-muted-foreground">
          Deben coincidir exactamente con los tokens {"{{variable}}"} del contenido e incluir
          unsubscribeUrl.
        </p>
      </div>
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          name="publish"
          checked={publish}
          onChange={(event) => {
            setUseServerValues(false);
            setPublish(event.target.checked);
          }}
          className="mt-1 size-4 accent-primary"
        />
        <span>Publicar esta versión y archivar la vigente anterior</span>
      </label>
      <Button type="submit" disabled={pending}>
        {pending ? "Versionando…" : "Guardar nueva versión"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
