import { expect, test } from "@playwright/test";

test("CMS, media and settings admin routes enforce the authenticated MFA shell", async ({
  page,
}) => {
  for (const route of [
    "/admin/contenido",
    "/admin/contenido/nuevo",
    "/admin/contenido/medios",
    "/admin/configuracion",
  ]) {
    await page.goto(route);
    await expect(page).toHaveURL(/\/admin\/login\?.*reason=security/);
  }
});

test("CMS scheduler rejects missing and invalid credentials", async ({ page }) => {
  const missing = await page.request.post("/api/jobs/cms-publish");
  expect(missing.status()).toBe(401);
  const invalid = await page.request.post("/api/jobs/cms-publish", {
    headers: { authorization: "Bearer invalid" },
  });
  expect(invalid.status()).toBe(401);
  const validButUnknownActor = await page.request.post("/api/jobs/cms-publish", {
    headers: { authorization: "Bearer e2e-cms-secret" },
  });
  expect(validButUnknownActor.status()).toBe(403);
});
