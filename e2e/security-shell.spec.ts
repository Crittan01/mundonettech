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
    "/admin/catalogo",
    "/admin/catalogo/nuevo",
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
