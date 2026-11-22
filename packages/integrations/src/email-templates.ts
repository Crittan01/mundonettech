import { EmailValidationError } from "./email-types.js";

export interface EmailTemplateDefinition {
  readonly templateKey: string;
  readonly subject: string;
  readonly htmlBody: string;
  readonly textBody: string;
  readonly variables: readonly string[];
}

const definitions = {
  "order.confirmed": {
    subject: "Recibimos tu pedido {{orderNumber}}",
    htmlBody:
      '<p>Hola. Recibimos tu pedido <strong>{{orderNumber}}</strong> en {{storeName}}.</p><p>Total: {{totalCop}}.</p><p><a href="{{receiptUrl}}">Consultar recibo</a></p><p><a href="{{unsubscribeUrl}}">Dejar de recibir avisos de pedidos</a></p>',
    textBody:
      "Recibimos tu pedido {{orderNumber}} en {{storeName}}. Total: {{totalCop}}. Recibo: {{receiptUrl}}. Baja de avisos: {{unsubscribeUrl}}",
    variables: ["orderNumber", "storeName", "totalCop", "receiptUrl", "unsubscribeUrl"],
  },
  "order.paid": {
    subject: "Pago confirmado para {{orderNumber}}",
    htmlBody:
      '<p>Tu pago para el pedido <strong>{{orderNumber}}</strong> quedó confirmado en {{storeName}}.</p><p><a href="{{receiptUrl}}">Ver recibo</a></p><p><a href="{{unsubscribeUrl}}">Dejar de recibir avisos de pedidos</a></p>',
    textBody:
      "Tu pago para {{orderNumber}} quedó confirmado en {{storeName}}. Recibo: {{receiptUrl}}. Baja de avisos: {{unsubscribeUrl}}",
    variables: ["orderNumber", "storeName", "receiptUrl", "unsubscribeUrl"],
  },
  "shipment.shipped": {
    subject: "Tu pedido {{orderNumber}} va en camino",
    htmlBody:
      '<p>El envío de tu pedido <strong>{{orderNumber}}</strong> fue despachado por {{storeName}}.</p><p>Referencia: {{trackingCode}}.</p><p><a href="{{receiptUrl}}">Consultar pedido</a></p><p><a href="{{unsubscribeUrl}}">Dejar de recibir avisos logísticos</a></p>',
    textBody:
      "El envío de {{orderNumber}} fue despachado por {{storeName}}. Referencia: {{trackingCode}}. Pedido: {{receiptUrl}}. Baja de avisos: {{unsubscribeUrl}}",
    variables: ["orderNumber", "storeName", "trackingCode", "receiptUrl", "unsubscribeUrl"],
  },
  "shipment.delivered": {
    subject: "Entrega confirmada de {{orderNumber}}",
    htmlBody:
      '<p>La entrega de tu pedido <strong>{{orderNumber}}</strong> quedó confirmada por {{storeName}}.</p><p><a href="{{receiptUrl}}">Ver pedido</a></p><p><a href="{{unsubscribeUrl}}">Dejar de recibir avisos logísticos</a></p>',
    textBody:
      "La entrega de {{orderNumber}} quedó confirmada por {{storeName}}. Pedido: {{receiptUrl}}. Baja de avisos: {{unsubscribeUrl}}",
    variables: ["orderNumber", "storeName", "receiptUrl", "unsubscribeUrl"],
  },
  "invoice.accepted": {
    subject: "Factura electrónica {{documentNumber}}",
    htmlBody:
      '<p>La factura electrónica <strong>{{documentNumber}}</strong> de tu pedido {{orderNumber}} fue aceptada por la DIAN y emitida por {{storeName}}.</p><p><a href="{{documentUrl}}">Descargar documento fiscal</a></p><p><a href="{{unsubscribeUrl}}">Dejar de recibir avisos fiscales</a></p>',
    textBody:
      "La factura {{documentNumber}} de {{orderNumber}} fue aceptada por la DIAN y emitida por {{storeName}}. Documento: {{documentUrl}}. Baja de avisos: {{unsubscribeUrl}}",
    variables: ["documentNumber", "orderNumber", "storeName", "documentUrl", "unsubscribeUrl"],
  },
  "credit-note.accepted": {
    subject: "Nota crédito {{documentNumber}}",
    htmlBody:
      '<p>La nota crédito <strong>{{documentNumber}}</strong> asociada a tu pedido {{orderNumber}} fue aceptada por la DIAN y emitida por {{storeName}}.</p><p><a href="{{documentUrl}}">Descargar nota crédito</a></p><p><a href="{{unsubscribeUrl}}">Dejar de recibir avisos fiscales</a></p>',
    textBody:
      "La nota crédito {{documentNumber}} de {{orderNumber}} fue aceptada por la DIAN y emitida por {{storeName}}. Documento: {{documentUrl}}. Baja de avisos: {{unsubscribeUrl}}",
    variables: ["documentNumber", "orderNumber", "storeName", "documentUrl", "unsubscribeUrl"],
  },
  "refund.completed": {
    subject: "Reembolso confirmado para {{orderNumber}}",
    htmlBody:
      '<p>El reembolso de tu pedido <strong>{{orderNumber}}</strong> por {{totalCop}} quedó confirmado por {{storeName}}.</p><p><a href="{{receiptUrl}}">Consultar pedido</a></p><p><a href="{{unsubscribeUrl}}">Dejar de recibir avisos de pedidos</a></p>',
    textBody:
      "El reembolso de {{orderNumber}} por {{totalCop}} quedó confirmado por {{storeName}}. Pedido: {{receiptUrl}}. Baja de avisos: {{unsubscribeUrl}}",
    variables: ["orderNumber", "storeName", "totalCop", "receiptUrl", "unsubscribeUrl"],
  },
  "postsale.updated": {
    subject: "Actualización de {{caseKind}} para {{orderNumber}}",
    htmlBody:
      '<p>Tu solicitud de {{caseKind}} <strong>{{caseId}}</strong> para el pedido {{orderNumber}} cambió a <strong>{{statusLabel}}</strong> en {{storeName}}.</p><p><a href="{{accessUrl}}">Consultar posventa</a></p><p><a href="{{unsubscribeUrl}}">Dejar de recibir avisos de posventa</a></p>',
    textBody:
      "Tu solicitud de {{caseKind}} {{caseId}} para {{orderNumber}} cambió a {{statusLabel}} en {{storeName}}. Posventa: {{accessUrl}}. Baja de avisos: {{unsubscribeUrl}}",
    variables: [
      "caseId",
      "caseKind",
      "orderNumber",
      "statusLabel",
      "storeName",
      "accessUrl",
      "unsubscribeUrl",
    ],
  },
  "support.ticket": {
    subject: "Actualización de tu PQR {{ticketNumber}}",
    htmlBody:
      '<p>Tu PQR <strong>{{ticketNumber}}</strong> cambió a <strong>{{statusLabel}}</strong> en {{storeName}}.</p><p><a href="{{supportUrl}}">Consultar PQR</a></p><p><a href="{{unsubscribeUrl}}">Dejar de recibir avisos de soporte</a></p>',
    textBody:
      "Tu PQR {{ticketNumber}} cambió a {{statusLabel}} en {{storeName}}. Consulta: {{supportUrl}}. Baja de avisos: {{unsubscribeUrl}}",
    variables: ["ticketNumber", "statusLabel", "storeName", "supportUrl", "unsubscribeUrl"],
  },
} as const satisfies Readonly<Record<string, Omit<EmailTemplateDefinition, "templateKey">>>;

export const emailTemplateKeys = Object.keys(definitions);

function validateKey(value: string): string {
  if (!Object.hasOwn(definitions, value))
    throw new EmailValidationError("Unknown email template key.");
  return value;
}

function tokens(value: string): string[] {
  return [...value.matchAll(/\{\{([a-zA-Z][a-zA-Z0-9]{0,59})\}\}/g)]
    .map((match) => match[1]!)
    .sort();
}

export function validateEmailTemplate(input: EmailTemplateDefinition): EmailTemplateDefinition {
  validateKey(input.templateKey);
  if (
    typeof input.subject !== "string" ||
    input.subject.trim() !== input.subject ||
    input.subject.length < 1 ||
    input.subject.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(input.subject) ||
    typeof input.htmlBody !== "string" ||
    input.htmlBody.length < 1 ||
    input.htmlBody.length > 200_000 ||
    typeof input.textBody !== "string" ||
    input.textBody.length < 1 ||
    input.textBody.length > 100_000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.htmlBody + input.textBody)
  ) {
    throw new EmailValidationError(
      "Email template content exceeds limits or contains control characters.",
    );
  }
  if (
    /<\/?(?:script|iframe|object|embed|form|meta|link|base)\b|\son[a-z]+\s*=|javascript\s*:|data\s*:\s*text\/html|expression\s*\(/i.test(
      input.htmlBody,
    )
  ) {
    throw new EmailValidationError("Email HTML contains active or unsafe content.");
  }
  if (
    !Array.isArray(input.variables) ||
    input.variables.length > 50 ||
    input.variables.some((variable) => !/^[a-zA-Z][a-zA-Z0-9]{0,59}$/.test(variable)) ||
    new Set(input.variables).size !== input.variables.length
  ) {
    throw new EmailValidationError("Email template variables must be unique safe identifiers.");
  }
  const declared = [...input.variables].sort();
  const used = [
    ...new Set([...tokens(input.subject), ...tokens(input.htmlBody), ...tokens(input.textBody)]),
  ].sort();
  if (JSON.stringify(declared) !== JSON.stringify(used) || !declared.includes("unsubscribeUrl")) {
    throw new EmailValidationError(
      "Template variables must exactly match their usage and include unsubscribeUrl.",
    );
  }
  if (
    /\{\{|\}\}/.test(input.subject.replaceAll(/\{\{[a-zA-Z][a-zA-Z0-9]{0,59}\}\}/g, "")) ||
    /\{\{|\}\}/.test(input.htmlBody.replaceAll(/\{\{[a-zA-Z][a-zA-Z0-9]{0,59}\}\}/g, ""))
  ) {
    throw new EmailValidationError("Email template contains malformed interpolation tokens.");
  }
  return { ...input, variables: declared };
}

export function defaultEmailTemplate(templateKey: string): EmailTemplateDefinition {
  validateKey(templateKey);
  const definition = definitions[templateKey as keyof typeof definitions];
  return {
    templateKey,
    subject: definition.subject,
    htmlBody: definition.htmlBody,
    textBody: definition.textBody,
    variables: [...definition.variables],
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderEmailTemplate(
  template: EmailTemplateDefinition,
  values: Readonly<Record<string, string>>,
): { subject: string; htmlBody: string; textBody: string } {
  const valid = validateEmailTemplate(template);
  const entries = Object.entries(values);
  if (
    entries.length !== valid.variables.length ||
    valid.variables.some((variable) => !Object.hasOwn(values, variable))
  ) {
    throw new EmailValidationError(
      "Email interpolation values do not match the template contract.",
    );
  }
  for (const [key, value] of entries) {
    if (
      typeof value !== "string" ||
      value.length > 4096 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    ) {
      throw new EmailValidationError(`Email variable ${key} is invalid.`);
    }
  }
  const interpolate = (body: string, html: boolean) =>
    body.replaceAll(/\{\{([a-zA-Z][a-zA-Z0-9]{0,59})\}\}/g, (_match, key: string) => {
      const value = values[key];
      if (value === undefined) throw new EmailValidationError(`Missing email variable ${key}.`);
      return html ? escapeHtml(value) : value;
    });
  const subject = interpolate(valid.subject, false);
  if (/[\r\n]/.test(subject))
    throw new EmailValidationError("Rendered email subject cannot contain line breaks.");
  return {
    subject,
    htmlBody: interpolate(valid.htmlBody, true),
    textBody: interpolate(valid.textBody, false),
  };
}
