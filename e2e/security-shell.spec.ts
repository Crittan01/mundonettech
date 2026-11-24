import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

declare global {
  interface Window {
    __cspViolations?: string[];
  }
}

async function attachSecurityCollectors(page: Page): Promise<{
  assertClean: () => Promise<void>;
}> {
  const browserErrors: string[] = [];

  await page.addInitScript(() => {
    window.__cspViolations = [];
    window.addEventListener("securitypolicyviolation", (event) => {
      window.__cspViolations?.push(`${event.violatedDirective}:${event.blockedURI}`);
    });
  });

  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /Content Security Policy|Refused to|violates.*directive/i.test(message.text())
    ) {
      browserErrors.push(message.text());
    }
  });

  return {
    async assertClean() {
      const cspViolations = await page.evaluate(() => window.__cspViolations ?? []);
      expect(cspViolations).toEqual([]);
      expect(browserErrors).toEqual([]);
    },
  };
}

const publicRoutes = [
  "/",
  "/ingresar",
  "/ingresar?reason=timeout",
  "/registro",
  "/recuperar",
  "/verificar-correo",
  "/admin/login",
  "/admin/login?reason=invitation",
  "/admin/invitacion",
] as const;

for (const route of publicRoutes) {
  test(`${route} renders on standalone server without CSP or WCAG 2/2.1 A/AA violations`, async ({
    page,
  }) => {
    const collector = await attachSecurityCollectors(page);
    const response = await page.goto(route, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1").first()).toBeVisible();

    const headers = response?.headers() ?? {};
    const csp = headers["content-security-policy"] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("https://challenges.cloudflare.com");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("'strict-dynamic'");

    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(headers["strict-transport-security"]).toContain("max-age=63072000");
    expect(headers["x-powered-by"]).toBeUndefined();

    if (route === "/") {
      await expect(page.getByRole("heading", { level: 1 })).toContainText(
        "Tecnología que conecta tu mundo.",
      );
    }
    if (route === "/ingresar?reason=timeout") {
      await expect(page.getByText(/inactividad/i)).toBeVisible();
    }
    if (route === "/admin/login?reason=invitation") {
      await expect(page.getByText(/Invitación activada/i)).toBeVisible();
    }

    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(accessibility.violations).toEqual([]);
    await collector.assertClean();
  });
}

test("unknown routes return accessible 404 without CSP or runtime errors", async ({ page }) => {
  const collector = await attachSecurityCollectors(page);
  const response = await page.goto("/ruta-no-existente-f0-5", { waitUntil: "domcontentloaded" });
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("No encontramos esta página");

  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await collector.assertClean();
});

test("protected account, MFA, and admin routes enforce unauthenticated redirects", async ({
  page,
}) => {
  for (const adminRoute of [
    "/admin",
    "/admin/usuarios",
    "/admin/seguridad",
    "/admin/auditoria",
    "/admin/hoy",
    "/admin/dashboard",
    "/admin/pedidos",
    "/admin/finanzas",
    "/admin/catalogo",
    "/admin/catalogo/nuevo",
    "/admin/contenido",
    "/admin/contenido/nuevo",
    "/admin/contenido/medios",
    "/admin/configuracion",
    "/admin/integraciones",
    "/admin/canales",
    "/admin/pagos",
    "/admin/logistica",
    "/admin/comunicaciones",
    "/admin/facturacion",
    "/admin/login/mfa",
  ]) {
    await page.goto(adminRoute);
    await expect(page).toHaveURL(/\/admin\/login\?.*reason=security/);
  }

  await page.goto("/mi-cuenta");
  await expect(page).toHaveURL(/\/ingresar\?.*reason=security/);
});

test("customer and admin authentication forms expose labelled keyboard-accessible controls", async ({
  page,
}) => {
  await page.goto("/registro");
  const email = page.getByLabel("Correo electrónico");
  await expect(email).toBeVisible();
  await email.fill("persona@example.test");
  await expect(email).toHaveValue("persona@example.test");
  await email.press("Tab");
  await expect(page.getByLabel("Contraseña", { exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(email).toBeFocused();

  await page.goto("/admin/login");
  const adminEmail = page.getByLabel("Correo corporativo");
  await expect(adminEmail).toBeVisible();
  await adminEmail.fill("operaciones@example.test");
  await adminEmail.press("Tab");
  await expect(page.getByLabel("Contraseña")).toBeFocused();
});

test("customer registration and recovery connect server field errors to their controls", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.route("https://challenges.cloudflare.com/**", async (route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: "window.turnstile={render(){return 'e2e-widget'},reset(){},remove(){}};",
    });
  });
  const { createServer } = await import("node:http");
  const turnstile = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/siteverify") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const token = new URLSearchParams(body).get("response") ?? "";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        success: true,
        action: token.replace(/^e2e_/, ""),
        hostname: "127.0.0.1",
        "error-codes": [],
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    turnstile.once("error", reject);
    turnstile.listen(54427, "127.0.0.1", () => {
      turnstile.off("error", reject);
      resolve();
    });
  });

  async function passChallenge(action: string) {
    const token = `e2e_${action}`;
    const input = page.locator('input[name="turnstileToken"]');
    await expect(input).toHaveValue("");
    await input.evaluate((element, value) => {
      (element as HTMLInputElement).value = value;
    }, token);
    await expect(input).toHaveValue(token);
  }

  async function expectFieldError(
    selector: string,
    errorId: string,
    message: string,
    describedBy: string = errorId,
  ) {
    const control = page.locator(selector);
    const error = page.locator(`#${errorId}`);
    await expect(error).toContainText(message);
    await expect(control).toHaveAttribute("aria-invalid", "true");
    await expect(control).toHaveAttribute("aria-describedby", describedBy);
    await expect(page.getByText(message, { exact: true })).toHaveCount(1);
  }

  try {
    await page.goto("/registro");
    const registration = page.locator("form").filter({
      has: page.getByRole("button", { name: "Crear cuenta" }),
    });
    await registration.evaluate((form) => {
      (form as HTMLFormElement).noValidate = true;
    });
    await page.getByLabel("Correo electrónico").fill("correo-invalido");
    await page.getByRole("button", { name: "Crear cuenta" }).click();
    await expectFieldError("#email", "registration-email-error", "Ingresa un correo válido.");
    await expect(
      page.getByRole("alert").filter({ hasText: "Revisa los datos ingresados." }),
    ).toHaveText("Revisa los datos ingresados.");

    await page.getByLabel("Correo electrónico").fill("persona@example.test");
    await page.getByLabel("Contraseña", { exact: true }).fill("ClaveSegura123!");
    await page.getByLabel("Confirma la contraseña").fill("ClaveSegura124!");
    await passChallenge("customer_register");
    await page.getByRole("button", { name: "Crear cuenta" }).click();
    await expectFieldError(
      "#confirmation",
      "registration-confirmation-error",
      "Las contraseñas no coinciden.",
    );
    await expect(page.locator("#registration-password-error")).toHaveCount(0);

    await page.getByLabel("Contraseña", { exact: true }).fill("password123!");
    await page.getByLabel("Confirma la contraseña").fill("password123!");
    await passChallenge("customer_register");
    await page.getByRole("button", { name: "Crear cuenta" }).click();
    const policyError = page.locator("#registration-password-error");
    await expect(policyError).toBeVisible();
    await expect(policyError.locator("li")).not.toHaveCount(0);
    await expect(page.getByLabel("Contraseña", { exact: true })).toHaveAttribute(
      "aria-describedby",
      "registration-password-help registration-password-error",
    );
    await expect(page.getByLabel("Contraseña", { exact: true })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "La contraseña no cumple la política de seguridad." }),
    ).toHaveText("La contraseña no cumple la política de seguridad.");

    await page.goto("/recuperar");
    const recovery = page.locator("form").filter({
      has: page.getByRole("button", { name: "Solicitar recuperación" }),
    });
    await recovery.evaluate((form) => {
      (form as HTMLFormElement).noValidate = true;
    });
    await page.getByLabel("Correo electrónico").fill("correo-invalido");
    await page.getByRole("button", { name: "Solicitar recuperación" }).click();
    await expectFieldError("#email", "recovery-request-email-error", "Ingresa un correo válido.");

    await page.goto("/recuperar?code=1");
    await expect(
      page.getByRole("button", { name: "Actualizar contraseña e ingresar" }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Solicitar recuperación" })).toBeVisible();

    await page.goto("/recuperar");
    await page.getByLabel("Correo electrónico").fill("persona@example.test");
    await passChallenge("customer_recovery");
    await page.getByRole("button", { name: "Solicitar recuperación" }).click();
    const recoveryLink = page.getByRole("link", { name: "Ingresar código y nueva contraseña" });
    await expect(recoveryLink).toHaveAttribute("href", "/recuperar?code=1");
    await recoveryLink.click();
    const reset = page.locator("form").filter({
      has: page.getByRole("button", { name: "Actualizar contraseña e ingresar" }),
    });
    await reset.evaluate((form) => {
      (form as HTMLFormElement).noValidate = true;
    });
    await page.getByLabel("Código de recuperación").fill("123456");
    await page.getByLabel("Contraseña", { exact: true }).fill("ClaveSegura123!");
    await page.getByLabel("Confirma la contraseña").fill("ClaveSegura124!");
    await passChallenge("customer_reset");
    await page.getByRole("button", { name: "Actualizar contraseña e ingresar" }).click();
    await expectFieldError(
      "#confirmation",
      "recovery-reset-confirmation-error",
      "Las contraseñas no coinciden.",
    );

    await reset.evaluate((form) => {
      (form as HTMLFormElement).noValidate = true;
    });
    await page.getByLabel("Código de recuperación").fill("123456");
    await page.getByLabel("Contraseña", { exact: true }).fill("password123!");
    await page.getByLabel("Confirma la contraseña").fill("password123!");
    await expect(page.getByLabel("Código de recuperación")).toHaveValue("123456");
    await expect(page.getByLabel("Contraseña", { exact: true })).toHaveValue("password123!");
    await expect(page.getByLabel("Confirma la contraseña")).toHaveValue("password123!");
    await passChallenge("customer_reset");
    await page.getByRole("button", { name: "Actualizar contraseña e ingresar" }).click();
    await expect(page.locator("#recovery-reset-password-error")).toBeVisible();
    await expect(page.getByLabel("Contraseña", { exact: true })).toHaveAttribute(
      "aria-describedby",
      "recovery-reset-password-help recovery-reset-password-error",
    );
    await expect(page.getByLabel("Contraseña", { exact: true })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  } finally {
    turnstile.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      turnstile.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
