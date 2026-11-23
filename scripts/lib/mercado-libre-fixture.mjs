import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

async function requestBody(request, maximumBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error("Mercado Libre fixture request is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function formBody(request) {
  return new URLSearchParams(await requestBody(request, 16 * 1024));
}

async function jsonBody(request) {
  const body = await requestBody(request);
  return body ? JSON.parse(body) : {};
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
  const items = new Map();
  const stocks = new Map();
  const sellerId = String(options.externalAccountId ?? 8035443);
  let sequence = 0;
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const method = request.method ?? "GET";
      const recordCall = (body = {}) => {
        const call = {
          method,
          path: url.pathname,
          query: url.search,
          body,
          authorization: request.headers.authorization ?? null,
          headers: request.headers,
        };
        calls.push(call);
        return call;
      };
      const reply = async (result) => {
        if (result.destroy) {
          request.socket.destroy();
          return true;
        }
        if (result.delayMs) await new Promise((resolve) => setTimeout(resolve, result.delayMs));
        response.writeHead(result.status ?? 200, {
          "content-type": "application/json",
          ...(result.version !== undefined ? { "x-version": String(result.version) } : {}),
          ...(result.headers ?? {}),
        });
        response.end(result.body === undefined ? "" : JSON.stringify(result.body));
        return true;
      };
      if (method === "POST" && url.pathname === "/oauth/token") {
        const body = await formBody(request);
        recordCall(Object.fromEntries(body));
        const result =
          (options.onToken ? await options.onToken(body, calls.length) : undefined) ??
          defaultGrant(body);
        if (result !== undefined && (await reply(result))) return;
      }
      const revokeMatch = /^\/users\/([0-9]+)\/applications\/([0-9]+)$/.exec(url.pathname);
      if (method === "DELETE" && revokeMatch) {
        recordCall();
        const result = (options.onRevoke ? await options.onRevoke(calls.at(-1)) : undefined) ?? {
          status: 200,
          body: {},
        };
        if (result !== undefined && (await reply(result))) return;
      }
      const searchMatch = /^\/users\/([0-9]+)\/items\/search$/.exec(url.pathname);
      if (method === "GET" && searchMatch) {
        recordCall();
        const result = (options.onSearchItems
          ? await options.onSearchItems(url.searchParams, calls.at(-1))
          : undefined) ?? {
          status: 200,
          body: {
            results: [...items.values()]
              .filter((item) => item.seller_sku === url.searchParams.get("seller_sku"))
              .map((item) => item.id),
          },
        };
        if (result !== undefined && (await reply(result))) return;
      }
      const sellerMatch = /^\/users\/([0-9]+)$/.exec(url.pathname);
      if (method === "GET" && sellerMatch) {
        recordCall();
        const result = (options.onSeller ? await options.onSeller(calls.at(-1)) : undefined) ?? {
          status: 200,
          body: { id: Number(sellerId), tags: ["user_product_seller", "normal"] },
        };
        if (result !== undefined && (await reply(result))) return;
      }
      if (method === "POST" && url.pathname === "/pictures/items/upload") {
        const body = await jsonBody(request);
        recordCall(body);
        const result = (options.onPictureUpload
          ? await options.onPictureUpload(body, calls.at(-1))
          : undefined) ?? {
          status: 200,
          body: { id: `picture-${++sequence}`, url: body.source },
        };
        if (result !== undefined && (await reply(result))) return;
      }
      if (method === "POST" && url.pathname === "/items") {
        const body = await jsonBody(request);
        recordCall(body);
        if (options.onCreateItem) {
          const result = await options.onCreateItem(body, calls.at(-1));
          if (result !== undefined && (await reply(result))) return;
        }
        const numericId = String(900_000_000 + ++sequence);
        const id = `MCO${numericId}`;
        const userProductId = body.user_product_id ?? `MCOU${numericId}`;
        const item = {
          id,
          user_product_id: userProductId,
          seller_id: Number(sellerId),
          status: "active",
          price: body.price,
          available_quantity: body.available_quantity ?? null,
          seller_sku: body.attributes?.find((attribute) => attribute.id === "SELLER_SKU")
            ?.value_name,
          shipping: body.shipping ?? {},
        };
        items.set(id, item);
        if (!stocks.has(userProductId)) {
          stocks.set(userProductId, {
            id: userProductId,
            user_id: Number(sellerId),
            version: 1,
            locations:
              body.shipping?.logistic_type === "fulfillment"
                ? [{ type: "meli_facility", quantity: 0 }]
                : [{ type: "selling_address", quantity: body.available_quantity ?? 0 }],
          });
        }
        if (await reply({ status: 201, body: item })) return;
      }
      const itemMatch = /^\/items\/(MCO[0-9]+)$/.exec(url.pathname);
      if (["GET", "PUT"].includes(method) && itemMatch) {
        const body = method === "PUT" ? await jsonBody(request) : {};
        recordCall(body);
        const current = items.get(itemMatch[1]);
        if (options.onItem) {
          const result = await options.onItem(
            { method, id: itemMatch[1], body, current },
            calls.at(-1),
          );
          if (result !== undefined && (await reply(result))) return;
        }
        if (!current) {
          if (await reply({ status: 404, body: { error: "not_found" } })) return;
        }
        if (method === "PUT") {
          Object.assign(current, {
            ...(body.price !== undefined ? { price: body.price } : {}),
            ...(body.available_quantity !== undefined
              ? { available_quantity: body.available_quantity }
              : {}),
            ...(body.status !== undefined ? { status: body.status } : {}),
          });
          const stock = stocks.get(current.user_product_id);
          const local = stock?.locations.find((location) => location.type === "selling_address");
          if (stock && local && body.available_quantity !== undefined) {
            local.quantity = body.available_quantity;
            stock.version += 1;
          }
        }
        if (await reply({ status: 200, body: current })) return;
      }
      const stockMatch = /^\/user-products\/(MCO[A-Z0-9]+)\/stock$/.exec(url.pathname);
      if (method === "GET" && stockMatch) {
        recordCall();
        const stock = stocks.get(stockMatch[1]);
        const result =
          (options.onStock
            ? await options.onStock({ id: stockMatch[1], current: stock }, calls.at(-1))
            : undefined) ??
          (stock
            ? {
                status: 200,
                version: stock.version,
                body: { id: stock.id, user_id: stock.user_id, locations: stock.locations },
              }
            : { status: 404, body: { error: "not_found" } });
        if (result !== undefined && (await reply(result))) return;
      }
      const warehouseMatch =
        /^\/user-products\/(MCO[A-Z0-9]+)\/stock\/type\/seller_warehouse$/.exec(url.pathname);
      if (["POST", "PUT"].includes(method) && warehouseMatch) {
        const body = await jsonBody(request);
        recordCall(body);
        const stock = stocks.get(warehouseMatch[1]);
        const suppliedVersion = request.headers["x-version"];
        if (options.onWarehouseStock) {
          const result = await options.onWarehouseStock(
            { method, id: warehouseMatch[1], body, current: stock, suppliedVersion },
            calls.at(-1),
          );
          if (result !== undefined && (await reply(result))) return;
        }
        if (!stock || String(stock.version) !== String(suppliedVersion)) {
          if (await reply({ status: 409, body: { error: "version_conflict" } })) return;
        }
        const location = stock.locations.find(
          (candidate) =>
            candidate.type === "seller_warehouse" &&
            candidate.store_id === body.store_id &&
            candidate.network_node_id === body.network_node_id,
        );
        if (method === "POST" && location) {
          if (await reply({ status: 409, body: { error: "location_exists" } })) return;
        }
        if (location) location.quantity = body.quantity;
        else {
          stock.locations.push({
            type: "seller_warehouse",
            store_id: body.store_id,
            network_node_id: body.network_node_id,
            quantity: body.quantity,
          });
        }
        stock.version += 1;
        if (await reply({ status: 200, version: stock.version, body: {} })) return;
      }
      recordCall();
      await reply({ status: 404, body: { error: "not_found" } });
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
    items,
    stocks,
    async stop() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
