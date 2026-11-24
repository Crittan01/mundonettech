import { fileURLToPath } from "node:url";

import {
  EmailConflictError,
  EmailProviderError,
  EmailValidationError,
} from "../../../packages/integrations/dist/index.js";
import { describe, expect, it, vi } from "vitest";

import { loadTypeScriptModule } from "./route-loader.js";

interface ActionResult {
  readonly status: string;
  readonly message: string;
  readonly values?: Record<string, string>;
}

const idle: ActionResult = { status: "idle", message: "" };

function templateForm(key = "template-action-stable-key") {
  const form = new FormData();
  form.set("templateKey", "order.paid");
  form.set("subject", "Asunto customer@example.test");
  form.set("htmlBody", '<p class="private">Contenido privado</p>');
  form.set("textBody", "Texto privado");
  form.set("variables", "unsubscribeUrl");
  form.set("idempotencyKey", key);
  return form;
}

function createAction() {
  const saveTemplate = vi.fn(
    async (input?: Record<string, unknown>, audit?: Record<string, unknown>) => {
      void input;
      void audit;
      return "template-version-id";
    },
  );
  const getAdminSession = vi.fn(async () => ({ profile: { id: crypto.randomUUID() } }));
  const getRequestSecurityContext = vi.fn(async () => ({
    ipHash: new Uint8Array(32).fill(1),
    userAgentHash: null,
  }));
  const revalidatePath = vi.fn();
  const loadedModule = loadTypeScriptModule<{
    readonly saveEmailTemplateAction: (
      previous: ActionResult,
      form: FormData,
    ) => Promise<ActionResult>;
  }>(
    fileURLToPath(
      new URL("../../../apps/web/lib/actions/admin-communications.ts", import.meta.url),
    ),
    {
      "@mundonettech/integrations": {
        EmailConflictError,
        EmailProviderError,
        EmailValidationError,
      },
      "next/cache": { revalidatePath },
      "@/lib/action-state": {
        actionError: (message: string, values?: Record<string, string>) => ({
          status: "error",
          message,
          ...(values ? { values } : {}),
        }),
        actionSuccess: (message: string) => ({ status: "success", message }),
        formSnapshot: (form: FormData) =>
          Object.fromEntries(
            [...form.entries()].filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
        formString: (form: FormData, key: string) => {
          const value = form.get(key);
          return typeof value === "string" ? value : "";
        },
      },
      "@/lib/integrations": { emailService: () => ({ saveTemplate }) },
      "@/lib/security/admin-auth": {
        AdminAuthorizationError: class extends Error {},
        getAdminSession,
      },
      "@/lib/security/request-context": { getRequestSecurityContext },
    },
  );
  return {
    action: loadedModule.saveEmailTemplateAction,
    saveTemplate,
    getAdminSession,
    revalidatePath,
  };
}

describe("A2 email template action stable key propagation", () => {
  it("requires communications MFA and forwards the exact render key without reflecting bodies", async () => {
    const current = createAction();
    const first = await current.action(idle, templateForm());
    const second = await current.action(idle, templateForm());
    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
    expect(current.getAdminSession).toHaveBeenCalledWith({
      permission: "communications:write",
      requireRecentMfa: true,
    });
    const requests = current.saveTemplate.mock.calls.map((call) => call[0]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.idempotencyKey).toBe("template-action-stable-key");
    expect(requests[1]?.idempotencyKey).toBe("template-action-stable-key");
    expect(JSON.stringify(first)).not.toContain("Contenido privado");
    expect(JSON.stringify(first)).not.toContain("customer@example.test");
    expect(JSON.stringify(first)).not.toContain("template-action-stable-key");
    expect(current.revalidatePath).toHaveBeenCalledWith("/admin/comunicaciones");
  });

  it("keeps the form closed and rejects a missing or duplicate idempotency key before service effects", async () => {
    const missing = createAction();
    const form = templateForm();
    form.delete("idempotencyKey");
    expect((await missing.action(idle, form)).status).toBe("error");
    expect(missing.saveTemplate).not.toHaveBeenCalled();

    const duplicated = createAction();
    const duplicateForm = templateForm();
    duplicateForm.append("idempotencyKey", "another-key");
    expect((await duplicated.action(idle, duplicateForm)).status).toBe("error");
    expect(duplicated.saveTemplate).not.toHaveBeenCalled();

    const unexpected = createAction();
    const unexpectedForm = templateForm();
    unexpectedForm.set("unexpected", "not-allowed");
    expect((await unexpected.action(idle, unexpectedForm)).status).toBe("error");
    expect(unexpected.saveTemplate).not.toHaveBeenCalled();
  });

  it("redacts real service failures while preserving only the operational safe snapshot", async () => {
    const current = createAction();
    current.saveTemplate.mockRejectedValueOnce(
      new EmailValidationError("provider raw response with secret"),
    );
    const result = await current.action(idle, templateForm());
    expect(result.status).toBe("error");
    expect(result.values).toEqual({ templateKey: "order.paid" });
    expect(JSON.stringify(result)).not.toContain("Contenido privado");
    expect(JSON.stringify(result)).not.toContain("customer@example.test");
    expect(JSON.stringify(result)).not.toContain("provider raw response");
    expect(JSON.stringify(result)).not.toContain("template-action-stable-key");
  });
});
