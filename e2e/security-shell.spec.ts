import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const publicRoutes = [
  "/",
  "/ingresar",
  "/registro",
  "/recuperar",
  "/admin/login",
  "/admin/invitacion",
];

for (const route of publicRoutes) {
  test(`${route} renders without CSP violations or WCAG A/AA violations`, async ({ page }) => {
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        /Content Security Policy|Refused to|violates.*directive/i.test(message.text())
      ) {
        browserErrors.push(message.text());
      }
    });

    const response = await page.goto(route, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1").first()).toBeVisible();
    const csp = response?.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");

    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(accessibility.violations).toEqual([]);
    expect(browserErrors).toEqual([]);
  });
}

test("protected account and admin routes require authentication", async ({ page }) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login\?.*reason=security/);
  await page.goto("/mi-cuenta");
  await expect(page).toHaveURL(/\/ingresar\?.*reason=security/);
});

test("authentication forms expose labelled keyboard-accessible fields", async ({ page }) => {
  await page.goto("/registro");
  const email = page.getByLabel("Correo electrónico");
  await expect(email).toBeVisible();
  await email.fill("persona@example.test");
  await expect(email).toHaveValue("persona@example.test");
  await email.press("Tab");
  await expect(page.getByLabel("Contraseña", { exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(email).toBeFocused();
});
