import { expect } from "vitest";

type Handler = () => Response | Promise<Response>;

export function expectNoStoreNoIndex(response: Response): void {
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-robots-tag")).toContain("noindex");
}

export async function expectMethodAllowlist(
  route: Record<string, unknown>,
  allowed: "GET" | "GET, POST" = "GET",
): Promise<void> {
  for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    if (allowed === "GET, POST" && method === "POST") continue;
    const handler = route[method];
    expect(handler, `${method} export`).toBeTypeOf("function");
    const response = await (handler as Handler)();
    expect(response.status, method).toBe(405);
    expect(response.headers.get("allow"), method).toBe(allowed);
    expectNoStoreNoIndex(response);
    if (method === "HEAD") {
      const body = await response.text();
      if (body.length > 0) {
        expect(JSON.parse(body), method).toEqual({ error: "Method not allowed." });
      }
    } else {
      expect(await response.json(), method).toEqual({ error: "Method not allowed." });
    }
  }
}
