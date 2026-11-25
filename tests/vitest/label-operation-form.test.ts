import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { ActionState } from "../../apps/web/lib/action-state";

const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));

function loadLogisticsModule<T>(path: string, mocks: Record<string, unknown>): T {
  const filename = fileURLToPath(new URL(`../../apps/web/${path}`, import.meta.url));
  const source = `${readFileSync(filename, "utf8")}\nexport { labelOperationButtonLabel, publishLabelOperationMessage };`;
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  }).outputText;
  const actionModule = { exports: {} as Record<string, unknown> };
  const localRequire = (id: string): unknown => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    return webRequire(id) as unknown;
  };
  new Function("exports", "require", "module", output)(
    actionModule.exports,
    localRequire,
    actionModule,
  );
  return actionModule.exports as T;
}

const idle: ActionState = { status: "idle", message: "" };
const action = async () => ({ status: "success" as const, message: "Operación completada." });

const logistics = loadLogisticsModule<{
  LabelOperationForm: (props: { packageId: string; reconcile?: boolean }) => React.ReactElement;
  labelOperationButtonLabel: (pending: boolean, reconcile: boolean) => string;
  publishLabelOperationMessage: (
    container: ParentNode,
    packageId: string,
    state: ActionState,
    documentRef?: Document,
  ) => void;
}>("components/admin/logistics-operations-forms.tsx", {
  "@/components/auth/form-message": { FormMessage: () => null },
  "@/components/ui/button": {
    Button: (props: React.ComponentProps<"button">) => createElement("button", props),
  },
  "@/components/ui/input": { Input: () => null },
  "@/components/ui/label": { Label: () => null },
  "@/lib/action-state": { initialActionState: idle },
  "@/lib/actions/admin-logistics": {
    archiveDeliveryZoneAction: action,
    assignShipmentSerialsAction: action,
    deliverShipmentAction: action,
    dispatchShipmentAction: action,
    packShipmentAction: action,
    processLabelAction: action,
    reconcileLabelAction: action,
    saveDeliveryZoneAction: action,
    startPickingAction: action,
  },
});

class FakeMessage {
  readonly dataset: { labelOperationMessage?: string } = {};
  readonly attributes = new Map<string, string>();
  className = "";
  textContent: string | null = null;
  removed = false;

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  remove(): void {
    this.removed = true;
  }
}

class FakeContainer {
  readonly messages: FakeMessage[] = [];

  querySelector(selector: string): FakeMessage | null {
    const packageId = /^output\[data-label-operation-message="([^"]+)"\]$/.exec(selector)?.[1];
    return (
      this.messages.find(
        (message) => !message.removed && message.dataset.labelOperationMessage === packageId,
      ) ?? null
    );
  }

  append(message: FakeMessage): void {
    this.messages.push(message);
  }
}

const documentRef = { createElement: () => new FakeMessage() } as unknown as Document;

function publish(container: FakeContainer, packageId: string, state: ActionState): void {
  logistics.publishLabelOperationMessage(
    container as unknown as ParentNode,
    packageId,
    state,
    documentRef,
  );
}

describe("LabelOperationForm accessible action feedback", () => {
  it("keeps pending and operation labels explicit", () => {
    expect(logistics.labelOperationButtonLabel(true, true)).toBe("Procesando…");
    expect(logistics.labelOperationButtonLabel(false, true)).toBe("Conciliar con proveedor");
    expect(logistics.labelOperationButtonLabel(false, false)).toBe("Solicitar guía");
  });

  it("renders only the active form controls and no initial empty message", () => {
    const markup = renderToStaticMarkup(
      createElement(logistics.LabelOperationForm, {
        packageId: "5b97a4f0-4a6c-4f6b-b5de-d0c0a0c3a640",
        reconcile: true,
      }),
    );
    expect(markup).toContain('name="packageId"');
    expect(markup).toContain("Conciliar con proveedor");
    expect(markup).not.toContain("data-label-operation-message");
    expect(markup).not.toContain("Operación completada");
  });

  it("persists success outside the form subtree, reuses it for errors and clears it on idle", () => {
    const container = new FakeContainer();
    publish(container, "package-1", idle);
    expect(container.messages).toHaveLength(0);

    publish(container, "package-1", {
      status: "success",
      message: "Guía conciliada sin duplicar cobro.",
    });
    expect(container.messages).toHaveLength(1);
    const message = container.messages[0]!;
    expect(message.dataset.labelOperationMessage).toBe("package-1");
    expect(message.attributes.get("role")).toBe("status");
    expect(message.attributes.get("aria-live")).toBe("polite");
    expect(message.attributes.get("aria-atomic")).toBe("true");
    expect(message.textContent).toBe("Guía conciliada sin duplicar cobro.");
    expect(message.removed).toBe(false);

    publish(container, "package-1", { status: "error", message: "No pudimos conciliar." });
    expect(container.messages).toHaveLength(1);
    expect(message.attributes.get("role")).toBe("alert");
    expect(message.attributes.get("aria-live")).toBe("assertive");
    expect(message.className).toContain("text-destructive");
    expect(message.textContent).toBe("No pudimos conciliar.");

    publish(container, "package-1", idle);
    expect(message.removed).toBe(true);
    publish(container, "package-1", { status: "success", message: "Nueva guía persistida." });
    expect(container.messages).toHaveLength(2);
    expect(container.messages[1]!.textContent).toBe("Nueva guía persistida.");
  });

  it("keeps feedback isolated by package", () => {
    const container = new FakeContainer();
    publish(container, "package-1", { status: "success", message: "Primera guía." });
    publish(container, "package-2", { status: "error", message: "Segunda guía fallida." });
    expect(container.messages).toHaveLength(2);
    expect(container.messages[0]!.textContent).toBe("Primera guía.");
    expect(container.messages[1]!.textContent).toBe("Segunda guía fallida.");
    expect(container.messages[0]!.attributes.get("role")).toBe("status");
    expect(container.messages[1]!.attributes.get("role")).toBe("alert");

    publish(container, "package-1", idle);
    expect(container.messages[0]!.removed).toBe(true);
    expect(container.messages[1]!.removed).toBe(false);
  });
});
