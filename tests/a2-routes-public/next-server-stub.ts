import { vi } from "vitest";

interface CookieOptions {
  readonly path?: string;
  readonly maxAge?: number;
  readonly expires?: Date;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: "lax" | "strict" | "none";
}

export class NextResponse extends Response {
  readonly cookies = {
    set: (name: string, value: string, options: CookieOptions): void => {
      const parts = [`${name}=${encodeURIComponent(value)}`];
      if (options.path) parts.push(`Path=${options.path}`);
      if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
      if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
      if (options.secure) parts.push("Secure");
      if (options.httpOnly) parts.push("HttpOnly");
      if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
      this.headers.set("Set-Cookie", parts.join("; "));
    },
  };
}

export const connection = vi.fn();
