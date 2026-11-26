"use client";

import { useActionState, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { emailTemplateLabels } from "@/lib/admin-presenters";
import { saveEmailTemplateAction } from "@/lib/actions/admin-communications";
import { initialActionState, type ActionState } from "@/lib/action-state";

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
  const [subject, setSubject] = useState(templates[firstKey]!.subject);
  const [htmlBody, setHtmlBody] = useState(templates[firstKey]!.htmlBody);
  const [textBody, setTextBody] = useState(templates[firstKey]!.textBody);
  const [variables, setVariables] = useState(templates[firstKey]!.variables.join(","));
  const [publish, setPublish] = useState(true);
  const [state, action, pending] = useActionState(
    async (previous: ActionState, formData: FormData) => {
      const result = await saveEmailTemplateAction(previous, formData);
      if (result.status === "success") {
        setRequestKey(crypto.randomUUID());
      }
      return result;
    },
    initialActionState,
  );
  function selectTemplate(key: string) {
    const template = templates[key]!;
    setTemplateKey(key);
    setSubject(template.subject);
    setHtmlBody(template.htmlBody);
    setTextBody(template.textBody);
    setVariables(template.variables.join(","));
  }
  return (
    <form action={action} aria-busy={pending} className="space-y-4">
      <input type="hidden" name="idempotencyKey" value={requestKey} />
      <div className="space-y-2">
        <Label htmlFor="email-template-key">Tipo de comunicación</Label>
        <Select
          id="email-template-key"
          name="templateKey"
          value={templateKey}
          onChange={(event) => selectTemplate(event.target.value)}
          disabled={pending}
        >
          {keys.map((key) => {
            const label = emailTemplateLabels[key];
            return (
              <option key={key} value={key}>
                {label ? `${label} (${key})` : key}
              </option>
            );
          })}
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="email-template-subject">Asunto</Label>
        <Input
          id="email-template-subject"
          name="subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          maxLength={200}
          required
          disabled={pending}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="email-template-html">HTML permitido, sin scripts ni contenido activo</Label>
        <Textarea
          id="email-template-html"
          name="htmlBody"
          value={htmlBody}
          onChange={(event) => setHtmlBody(event.target.value)}
          rows={10}
          maxLength={200_000}
          className="font-mono"
          required
          disabled={pending}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="email-template-text">Versión de texto</Label>
        <Textarea
          id="email-template-text"
          name="textBody"
          value={textBody}
          onChange={(event) => setTextBody(event.target.value)}
          rows={6}
          maxLength={100_000}
          required
          disabled={pending}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="email-template-variables">Variables usadas, separadas por coma</Label>
        <Input
          id="email-template-variables"
          name="variables"
          value={variables}
          onChange={(event) => setVariables(event.target.value)}
          required
          disabled={pending}
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
          onChange={(event) => setPublish(event.target.checked)}
          disabled={pending}
          className="mt-1 size-4 shrink-0 accent-primary"
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
