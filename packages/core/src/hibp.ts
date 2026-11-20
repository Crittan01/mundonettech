import { createHash } from "node:crypto";

export interface PasswordBreachOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

export async function isPasswordCompromised(
  password: string,
  options: PasswordBreachOptions = {},
): Promise<boolean> {
  if (password.length < 1 || password.length > 128) throw new TypeError("Invalid password length.");
  const sha1 = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  const response = await (options.fetchImpl ?? fetch)(
    `${options.baseUrl ?? "https://api.pwnedpasswords.com"}/range/${prefix}`,
    {
      headers: {
        "Add-Padding": "true",
        Accept: "text/plain",
        "Cache-Control": "no-cache",
        "User-Agent": "password-security-check",
      },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    },
  );
  if (!response.ok) throw new Error("Password breach verification is unavailable.");
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > 2_000_000) throw new Error("Invalid password breach response.");
  const body = await response.text();
  if (body.length > 2_000_000) throw new Error("Invalid password breach response.");
  for (const line of body.split(/\r?\n/)) {
    const match = /^([A-F0-9]{35}):([0-9]{1,10})$/.exec(line.trim());
    if (match?.[1] === suffix && Number(match[2]) > 0) return true;
  }
  return false;
}
