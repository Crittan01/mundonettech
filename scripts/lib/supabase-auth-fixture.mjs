import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const signatureSecret = "mundonettech-e2e-auth-only-not-a-production-secret";
const fixtureMarker = "mundonettech-e2e-auth-v1";
const validTotpCode = "123456";

function sign(value) {
  return createHmac("sha256", signatureSecret).update(value).digest("base64url");
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function fixtureUser(payload) {
  const createdAt = new Date(payload.iat * 1000).toISOString();
  const factors = payload.has_verified_factor
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
    typeof parsed.has_verified_factor !== "boolean" ||
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
        ["password", "otp", "totp"].includes(entry.method) &&
        Number.isSafeInteger(entry.timestamp),
    )
  ) {
    throw new Error("Invalid fixture token payload.");
  }
  return parsed;
}

export function createSupabaseFixtureSession({
  subject,
  email,
  factorId,
  aal = "aal2",
  mfaAgeSeconds = 60,
  hasVerifiedFactor = true,
  now = new Date(),
}) {
  if (!uuidPattern.test(subject) || !uuidPattern.test(factorId)) {
    throw new Error("Fixture subject and factor must be UUIDs.");
  }
  if (!["aal1", "aal2"].includes(aal)) {
    throw new Error("Invalid fixture assurance level.");
  }
  if (!Number.isSafeInteger(mfaAgeSeconds) || mfaAgeSeconds < 0) {
    throw new Error("Invalid fixture MFA age.");
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
  const amr =
    aal === "aal2"
      ? [
          { method: "password", timestamp: issuedAt - Math.max(mfaAgeSeconds, 60) },
          { method: "totp", timestamp: issuedAt - mfaAgeSeconds },
        ]
      : [{ method: "password", timestamp: issuedAt - 60 }];
  const payload = {
    fixture: fixtureMarker,
    sub: subject,
    email,
    factor_id: factorId,
    has_verified_factor: Boolean(hasVerifiedFactor),
    iat: issuedAt,
    exp: issuedAt + 3600,
    aal,
    amr,
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

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 16 * 1024) throw new Error("Request body too large.");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startSupabaseAuthFixture({ host = "127.0.0.1", port = 54429 } = {}) {
  const pendingChallenges = new Map();

  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    const pathname = (request.url ?? "").split("?")[0];

    try {
      const authorization = request.headers.authorization ?? "";
      if (!authorization.startsWith("Bearer ")) throw new Error("Missing bearer token.");
      const payload = payloadFromToken(authorization.slice(7));

      if (request.method === "GET" && pathname === "/auth/v1/user") {
        response.writeHead(200).end(JSON.stringify(fixtureUser(payload)));
        return;
      }

      const challengeMatch = /^\/auth\/v1\/factors\/([^/]+)\/challenge$/.exec(pathname);
      if (request.method === "POST" && challengeMatch) {
        const factorId = decodeURIComponent(challengeMatch[1]);
        if (factorId !== payload.factor_id || !payload.has_verified_factor) {
          response.writeHead(404).end(JSON.stringify({ code: 404, msg: "Factor not found." }));
          return;
        }
        const challengeId = randomUUID();
        const expiresAt = Math.floor(Date.now() / 1000) + 300;
        pendingChallenges.set(challengeId, {
          subject: payload.sub,
          factorId,
          expiresAt,
        });
        response
          .writeHead(200)
          .end(JSON.stringify({ id: challengeId, type: "totp", expires_at: expiresAt }));
        return;
      }

      const verifyMatch = /^\/auth\/v1\/factors\/([^/]+)\/verify$/.exec(pathname);
      if (request.method === "POST" && verifyMatch) {
        const factorId = decodeURIComponent(verifyMatch[1]);
        const body = await readJsonBody(request);
        const challenge = pendingChallenges.get(body.challenge_id);
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (
          !challenge ||
          challenge.subject !== payload.sub ||
          challenge.factorId !== factorId ||
          challenge.expiresAt <= nowSeconds
        ) {
          response
            .writeHead(422)
            .end(
              JSON.stringify({ code: 422, error_code: "mfa_challenge_expired", msg: "Expired." }),
            );
          return;
        }
        pendingChallenges.delete(body.challenge_id);
        if (body.code !== validTotpCode) {
          response.writeHead(422).end(
            JSON.stringify({
              code: 422,
              error_code: "mfa_verification_failed",
              msg: "Invalid TOTP.",
            }),
          );
          return;
        }
        const refreshed = createSupabaseFixtureSession({
          subject: payload.sub,
          email: payload.email,
          factorId: payload.factor_id,
          aal: "aal2",
          mfaAgeSeconds: 0,
        });
        response.writeHead(200).end(JSON.stringify(refreshed));
        return;
      }

      response.writeHead(404).end(JSON.stringify({ error: "Not found." }));
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
