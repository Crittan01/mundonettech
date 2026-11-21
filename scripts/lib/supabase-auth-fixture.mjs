import { createHmac } from "node:crypto";
import { createServer } from "node:http";

const signatureSecret = "mundonettech-e2e-auth-only-not-a-production-secret";
const fixtureMarker = "mundonettech-e2e-auth-v1";

function sign(value) {
  return createHmac("sha256", signatureSecret).update(value).digest("base64url");
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function fixtureUser(payload) {
  const createdAt = new Date(payload.iat * 1000).toISOString();
  const factors =
    payload.aal === "aal2"
      ? [
          {
            id: payload.factor_id,
            friendly_name: "E2E TOTP",
            factor_type: "totp",
            status: "verified",
            created_at: createdAt,
            updated_at: createdAt,
          },
        ]
      : [];
  return {
    id: payload.sub,
    aud: "authenticated",
    role: "authenticated",
    email: payload.email,
    email_confirmed_at: createdAt,
    phone: "",
    confirmed_at: createdAt,
    last_sign_in_at: createdAt,
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: {},
    identities: [],
    created_at: createdAt,
    updated_at: createdAt,
    factors,
  };
}

function payloadFromToken(token) {
  const [header, payload, suppliedSignature, extra] = token.split(".");
  if (
    !header ||
    !payload ||
    suppliedSignature !== sign(`${header}.${payload}`) ||
    extra !== undefined
  ) {
    throw new Error("Invalid fixture token.");
  }
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  const now = Math.floor(Date.now() / 1000);
  if (
    parsed.fixture !== fixtureMarker ||
    !uuidPattern.test(parsed.sub) ||
    !uuidPattern.test(parsed.factor_id) ||
    typeof parsed.email !== "string" ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parsed.email) ||
    parsed.email.length > 320 ||
    !Number.isSafeInteger(parsed.iat) ||
    !Number.isSafeInteger(parsed.exp) ||
    parsed.exp <= now ||
    parsed.iat > now + 30 ||
    !["aal1", "aal2"].includes(parsed.aal) ||
    !Array.isArray(parsed.amr) ||
    !parsed.amr.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        ["otp", "totp"].includes(entry.method) &&
        Number.isSafeInteger(entry.timestamp),
    )
  ) {
    throw new Error("Invalid fixture token payload.");
  }
  return parsed;
}

export function createSupabaseFixtureSession({ subject, email, factorId, now = new Date() }) {
  if (!uuidPattern.test(subject) || !uuidPattern.test(factorId)) {
    throw new Error("Fixture subject and factor must be UUIDs.");
  }
  if (
    typeof email !== "string" ||
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new Error("Invalid fixture email.");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("Invalid fixture clock.");
  }
  const issuedAt = Math.floor(now.getTime() / 1000);
  const payload = {
    fixture: fixtureMarker,
    sub: subject,
    email,
    factor_id: factorId,
    iat: issuedAt,
    exp: issuedAt + 3600,
    aal: "aal2",
    amr: [{ method: "totp", timestamp: issuedAt - 60 }],
  };
  const signingInput = `${encodeJson({ alg: "HS256", typ: "JWT" })}.${encodeJson(payload)}`;
  return {
    access_token: `${signingInput}.${sign(signingInput)}`,
    refresh_token: `e2e-refresh-${subject}`,
    expires_in: 3600,
    expires_at: payload.exp,
    token_type: "bearer",
    user: fixtureUser(payload),
  };
}

export function encodeSupabaseFixtureCookie(session) {
  return `base64-${encodeJson(session)}`;
}

export async function startSupabaseAuthFixture({ host = "127.0.0.1", port = 54429 } = {}) {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    if (request.method !== "GET" || request.url !== "/auth/v1/user") {
      response.writeHead(404).end(JSON.stringify({ error: "Not found." }));
      return;
    }
    try {
      const authorization = request.headers.authorization ?? "";
      if (!authorization.startsWith("Bearer ")) throw new Error("Missing bearer token.");
      const payload = payloadFromToken(authorization.slice(7));
      response.writeHead(200).end(JSON.stringify(fixtureUser(payload)));
    } catch {
      response.writeHead(401).end(
        JSON.stringify({
          code: 401,
          error_code: "invalid_jwt",
          msg: "Invalid E2E JWT.",
        }),
      );
    }
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  return {
    origin: `http://${host}:${port}`,
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
