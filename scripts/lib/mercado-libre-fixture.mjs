import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

async function formBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024) throw new Error("OAuth fixture request is too large.");
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function defaultGrant(body) {
  if (!["authorization_code", "refresh_token"].includes(body.get("grant_type") ?? "")) {
    return { status: 400, body: { error: "unsupported_grant_type" } };
  }
  return {
    status: 200,
    body: {
      access_token: `APP_USR-test-${randomUUID()}`,
      token_type: "bearer",
      expires_in: 3600,
      scope: "offline_access read write",
      user_id: 8035443,
      refresh_token: `TG-test-${randomUUID()}`,
    },
  };
}

export async function startMercadoLibreFixture(options = {}) {
  const calls = [];
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "POST" && url.pathname === "/oauth/token") {
        const body = await formBody(request);
        calls.push({
          method: "POST",
          path: url.pathname,
          query: url.search,
          body: Object.fromEntries(body),
          authorization: request.headers.authorization ?? null,
        });
        const result = options.onToken
          ? await options.onToken(body, calls.length)
          : defaultGrant(body);
        if (result.destroy) {
          request.socket.destroy();
          return;
        }
        if (result.delayMs) await new Promise((resolve) => setTimeout(resolve, result.delayMs));
        response.writeHead(result.status ?? 200, { "content-type": "application/json" });
        response.end(JSON.stringify(result.body));
        return;
      }
      const revokeMatch = /^\/users\/([0-9]+)\/applications\/([0-9]+)$/.exec(url.pathname);
      if (request.method === "DELETE" && revokeMatch) {
        calls.push({
          method: "DELETE",
          path: url.pathname,
          query: url.search,
          body: {},
          authorization: request.headers.authorization ?? null,
        });
        const result = options.onRevoke
          ? await options.onRevoke(calls.at(-1))
          : { status: 200, body: {} };
        if (result.destroy) {
          request.socket.destroy();
          return;
        }
        response.writeHead(result.status ?? 200, { "content-type": "application/json" });
        response.end(JSON.stringify(result.body ?? {}));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid_request" }));
    }
  });
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 54420;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return {
    origin: `http://${host}:${port}`,
    calls,
    async stop() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
