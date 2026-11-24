import { createServer } from "node:http";

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 131_072) throw new Error("Meta fixture request is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function startMetaCapiFixture(options = {}) {
  const calls = [];
  let sequence = 0;
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method !== "POST" || !/^\/[0-9]{5,32}\/events$/.test(url.pathname)) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      const rawBody = await body(request);
      const call = {
        method: request.method,
        path: url.pathname,
        query: url.search,
        rawBody,
        body: JSON.parse(rawBody),
        authorization: request.headers.authorization ?? null,
        headers: request.headers,
        sequence: ++sequence,
      };
      calls.push(call);
      const result = (await options.onEvent?.(call, sequence)) ?? {};
      if (result.destroy) {
        request.socket.destroy();
        return;
      }
      if (result.delayMs) await new Promise((resolve) => setTimeout(resolve, result.delayMs));
      response.writeHead(result.status ?? 200, {
        "content-type": "application/json",
        ...(result.headers ?? {}),
      });
      response.end(
        JSON.stringify(
          result.body ?? { events_received: 1, fbtrace_id: `meta-trace-${call.sequence}` },
        ),
      );
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end("{}");
    }
  });
  const port = options.port ?? 54420;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    calls,
    async stop() {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
