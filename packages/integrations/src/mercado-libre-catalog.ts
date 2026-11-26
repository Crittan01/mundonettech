import { fetchWithLimit, IntegrationTransportError, parseHttpJson } from "./integration-http.js";
import type { MercadoLibreTokenCredential } from "./mercado-libre.js";

const mercadoLibreApiUrl = "https://api.mercadolibre.com/";
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const maxResponseBytes = 1_000_000;

export type MercadoLibreCatalogErrorCode =
  | "INVALID_INPUT"
  | "INVALID_RESPONSE"
  | "UNAUTHORIZED"
  | "PROVIDER_REJECTED"
  | "VERSION_CONFLICT"
  | "NOT_FOUND"
  | "PROVIDER_UNCERTAIN";

export class MercadoLibreCatalogError extends Error {
  constructor(
    readonly code: MercadoLibreCatalogErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MercadoLibreCatalogError";
  }
}

export interface MercadoLibreCatalogClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly apiUrl?: string;
  readonly allowLoopback?: boolean;
}

export interface MercadoLibreAttributeInput {
  readonly id?: string;
  readonly name?: string;
  readonly valueName: string;
}

export interface MercadoLibreCreateItemInput {
  readonly familyName: string;
  readonly categoryId: string;
  readonly priceCents: bigint;
  readonly quantity?: number;
  readonly listingTypeId: "gold_special" | "gold_pro";
  readonly fulfillment: boolean;
  readonly description: string;
  readonly pictureIds: readonly string[];
  readonly attributes: readonly MercadoLibreAttributeInput[];
  readonly userProductId?: string;
}

export interface MercadoLibreItemSnapshot {
  readonly id: string;
  readonly userProductId: string;
  readonly sellerId: string;
  readonly status: string;
  readonly priceCents: bigint;
  readonly availableQuantity: number | null;
  readonly fulfillment: boolean;
}

export interface MercadoLibreStockLocation {
  readonly type: "meli_facility" | "seller_warehouse" | "selling_address";
  readonly quantity: number;
  readonly storeId: string | null;
  readonly networkNodeId: string | null;
}

export interface MercadoLibreStockSnapshot {
  readonly userProductId: string;
  readonly version: bigint;
  readonly locations: readonly MercadoLibreStockLocation[];
}

function apiEndpoint(value: string, allowLoopback: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MercadoLibreCatalogError("INVALID_INPUT", "The Mercado Libre API URL is invalid.");
  }
  const official =
    url.protocol === "https:" &&
    url.hostname === "api.mercadolibre.com" &&
    (url.pathname === "/" || url.pathname === "") &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash;
  const loopback =
    allowLoopback &&
    loopbackHosts.has(url.hostname.toLowerCase()) &&
    ["http:", "https:"].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash;
  if (!official && !loopback) {
    throw new MercadoLibreCatalogError(
      "INVALID_INPUT",
      "The Mercado Libre API endpoint is not allowed.",
    );
  }
  return url.toString().endsWith("/") ? url.toString() : `${url.toString()}/`;
}

function externalId(value: string, field: string, pattern: RegExp): string {
  if (!pattern.test(value)) {
    throw new MercadoLibreCatalogError("INVALID_INPUT", `${field} has an invalid format.`);
  }
  return value;
}

function itemId(value: string): string {
  return externalId(value, "itemId", /^MCO[0-9]{1,59}$/);
}

function userProductId(value: string): string {
  return externalId(value, "userProductId", /^MCO[A-Z0-9]{2,61}$/);
}

function sellerId(value: unknown): string {
  if (!(
    (typeof value === "string" && /^[0-9]{1,64}$/.test(value)) ||
    (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
  )) {
    throw new MercadoLibreCatalogError(
      "INVALID_RESPONSE",
      "Mercado Libre returned an invalid seller.",
    );
  }
  return BigInt(value).toString();
}

function quantity(value: unknown, field = "quantity"): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new MercadoLibreCatalogError(
      "INVALID_RESPONSE",
      `${field} is not a valid stock quantity.`,
    );
  }
  return value;
}

function wholeCopCents(value: unknown): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new MercadoLibreCatalogError(
      "INVALID_RESPONSE",
      "Mercado Libre returned an invalid COP price.",
    );
  }
  return BigInt(value) * 100n;
}

function priceNumber(priceCents: bigint): number {
  if (typeof priceCents !== "bigint" || priceCents <= 0n || priceCents % 100n !== 0n) {
    throw new MercadoLibreCatalogError(
      "INVALID_INPUT",
      "Mercado Libre COP prices must be positive whole pesos.",
    );
  }
  const value = priceCents / 100n;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MercadoLibreCatalogError(
      "INVALID_INPUT",
      "The COP price exceeds the provider range.",
    );
  }
  return Number(value);
}

function inputText(value: string, field: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new MercadoLibreCatalogError(
      "INVALID_INPUT",
      `${field} is not printable or is too long.`,
    );
  }
  return value;
}

function validateContentInput(input: {
  readonly familyName?: string;
  readonly description?: string;
  readonly pictureIds?: readonly string[];
  readonly attributes?: readonly MercadoLibreAttributeInput[];
}): void {
  if (input.familyName !== undefined) inputText(input.familyName, "familyName", 200);
  if (input.description !== undefined) inputText(input.description, "description", 5_000);
  if (input.pictureIds) {
    if (input.pictureIds.length < 1 || input.pictureIds.length > 12) {
      throw new MercadoLibreCatalogError(
        "INVALID_INPUT",
        "An item requires between one and twelve pictures.",
      );
    }
    for (const id of input.pictureIds) externalId(id, "pictureId", /^[A-Za-z0-9_-]{1,160}$/);
  }
  if (input.attributes) {
    if (input.attributes.length > 100) {
      throw new MercadoLibreCatalogError("INVALID_INPUT", "Too many item attributes.");
    }
    const keys = new Set<string>();
    for (const attribute of input.attributes) {
      if (!attribute.id && !attribute.name) {
        throw new MercadoLibreCatalogError("INVALID_INPUT", "An attribute requires id or name.");
      }
      if (attribute.id) inputText(attribute.id, "attribute id", 80);
      if (attribute.name) inputText(attribute.name, "attribute name", 120);
      inputText(attribute.valueName, "attribute value", 500);
      const key = attribute.id ?? attribute.name ?? "";
      if (keys.has(key)) {
        throw new MercadoLibreCatalogError(
          "INVALID_INPUT",
          "Duplicate item attributes are not allowed.",
        );
      }
      keys.add(key);
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MercadoLibreCatalogError(
      "INVALID_RESPONSE",
      "Mercado Libre returned an invalid object.",
    );
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string, maximum = 200): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new MercadoLibreCatalogError("INVALID_RESPONSE", `${field} is invalid.`);
  }
  return value;
}

function parseItem(
  body: string,
  expectedSellerId: string,
  expected: { readonly itemId?: string; readonly userProductId?: string } = {},
): MercadoLibreItemSnapshot {
  const root = record(parseHttpJson(body));
  const id = itemId(stringValue(root.id, "id", 64));
  const externalUserProductId = userProductId(
    stringValue(root.user_product_id, "user_product_id", 64),
  );
  const actualSellerId = sellerId(root.seller_id);
  if (actualSellerId !== expectedSellerId) {
    throw new MercadoLibreCatalogError(
      "INVALID_RESPONSE",
      "Mercado Libre returned an item for another seller.",
    );
  }
  if (root.currency_id !== "COP") {
    throw new MercadoLibreCatalogError(
      "INVALID_RESPONSE",
      "Mercado Libre returned an item without COP currency.",
    );
  }
  if (
    (expected.itemId !== undefined && id !== expected.itemId) ||
    (expected.userProductId !== undefined && externalUserProductId !== expected.userProductId)
  ) {
    throw new MercadoLibreCatalogError(
      "INVALID_RESPONSE",
      "Mercado Libre returned a different item or User Product.",
    );
  }
  const status = stringValue(root.status, "status", 30);
  if (!["active", "paused", "closed", "inactive", "under_review"].includes(status)) {
    throw new MercadoLibreCatalogError(
      "INVALID_RESPONSE",
      "Mercado Libre returned an unknown item status.",
    );
  }
  const shipping =
    typeof root.shipping === "object" && root.shipping !== null && !Array.isArray(root.shipping)
      ? root.shipping
      : {};
  const logisticType = (shipping as Record<string, unknown>).logistic_type;
  if (
    logisticType !== undefined &&
    !["fulfillment", "cross_docking", "remote", "xd_drop_off", "self_service"].includes(
      String(logisticType),
    )
  ) {
    throw new MercadoLibreCatalogError(
      "INVALID_RESPONSE",
      "Mercado Libre returned an unknown logistic type.",
    );
  }
  return {
    id,
    userProductId: externalUserProductId,
    sellerId: actualSellerId,
    status,
    priceCents: wholeCopCents(root.price),
    availableQuantity:
      root.available_quantity == null
        ? null
        : quantity(root.available_quantity, "available_quantity"),
    fulfillment: logisticType === "fulfillment",
  };
}

function version(value: string | null): bigint {
  if (!value || !/^[0-9]{1,19}$/.test(value)) {
    throw new MercadoLibreCatalogError(
      "INVALID_RESPONSE",
      "Mercado Libre omitted a valid x-version header.",
    );
  }
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n) {
    throw new MercadoLibreCatalogError("INVALID_RESPONSE", "The x-version header exceeds INT8.");
  }
  return parsed;
}

function stockSnapshot(
  body: string,
  rawVersion: string | null,
  expectedSellerId: string,
  expectedUserProductId: string,
): MercadoLibreStockSnapshot {
  const root = record(parseHttpJson(body));
  const id = userProductId(stringValue(root.id, "id", 64));
  if (sellerId(root.user_id) !== expectedSellerId || id !== expectedUserProductId) {
    throw new MercadoLibreCatalogError(
      "INVALID_RESPONSE",
      "The stock belongs to another seller or User Product.",
    );
  }
  if (!Array.isArray(root.locations) || root.locations.length > 100) {
    throw new MercadoLibreCatalogError(
      "INVALID_RESPONSE",
      "Mercado Libre returned invalid stock locations.",
    );
  }
  const seen = new Set<string>();
  const locations = root.locations.map((entry): MercadoLibreStockLocation => {
    const location = record(entry);
    const type = stringValue(location.type, "type", 30);
    if (!["meli_facility", "seller_warehouse", "selling_address"].includes(type)) {
      throw new MercadoLibreCatalogError(
        "INVALID_RESPONSE",
        "Unknown Mercado Libre stock location type.",
      );
    }
    const storeId =
      location.store_id == null ? null : stringValue(location.store_id, "store_id", 64);
    const networkNodeId =
      location.network_node_id == null
        ? null
        : stringValue(location.network_node_id, "network_node_id", 64);
    if (type === "seller_warehouse" && (!storeId || !networkNodeId)) {
      throw new MercadoLibreCatalogError(
        "INVALID_RESPONSE",
        "A seller warehouse requires store and node IDs.",
      );
    }
    if (type !== "seller_warehouse" && (storeId || networkNodeId)) {
      throw new MercadoLibreCatalogError(
        "INVALID_RESPONSE",
        "Unexpected warehouse identifiers in stock.",
      );
    }
    const key = `${type}:${storeId ?? ""}:${networkNodeId ?? ""}`;
    if (seen.has(key)) {
      throw new MercadoLibreCatalogError(
        "INVALID_RESPONSE",
        "Mercado Libre returned duplicate stock locations.",
      );
    }
    seen.add(key);
    return {
      type: type as MercadoLibreStockLocation["type"],
      quantity: quantity(location.quantity),
      storeId,
      networkNodeId,
    };
  });
  return { userProductId: id, version: version(rawVersion), locations };
}

export class MercadoLibreUserProductsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly apiUrl: string;
  private readonly allowLoopback: boolean;

  constructor(options: MercadoLibreCatalogClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.apiUrl = apiEndpoint(options.apiUrl ?? mercadoLibreApiUrl, options.allowLoopback === true);
    this.allowLoopback = options.allowLoopback === true;
  }

  protected async request(
    credential: MercadoLibreTokenCredential,
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    let response;
    try {
      response = await fetchWithLimit({
        url: new URL(path, this.apiUrl).toString(),
        init: {
          method,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${credential.accessToken}`,
            ...(body ? { "content-type": "application/json" } : {}),
            ...headers,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: "error",
        },
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
        maximumBytes: maxResponseBytes,
      });
    } catch (error) {
      if (error instanceof IntegrationTransportError) {
        throw new MercadoLibreCatalogError(
          "PROVIDER_UNCERTAIN",
          "Mercado Libre did not produce a deterministic response.",
        );
      }
      throw error;
    }
    if (response.status === 409) {
      throw new MercadoLibreCatalogError(
        "VERSION_CONFLICT",
        "Mercado Libre reported a version conflict.",
      );
    }
    if (response.status === 404) {
      throw new MercadoLibreCatalogError("NOT_FOUND", "The Mercado Libre resource was not found.");
    }
    if (response.status === 401) {
      throw new MercadoLibreCatalogError(
        "UNAUTHORIZED",
        "Mercado Libre rejected the channel credentials.",
      );
    }
    if (response.status === 400 || response.status === 403 || response.status === 422) {
      throw new MercadoLibreCatalogError(
        "PROVIDER_REJECTED",
        "Mercado Libre rejected the request.",
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new MercadoLibreCatalogError(
        "PROVIDER_UNCERTAIN",
        "Mercado Libre returned an uncertain result.",
      );
    }
    return response;
  }

  async assertUserProductsEnabled(credential: MercadoLibreTokenCredential): Promise<void> {
    const response = await this.request(
      credential,
      "GET",
      `users/${encodeURIComponent(credential.externalAccountId)}`,
    );
    const root = record(parseHttpJson(response.body));
    if (sellerId(root.id) !== credential.externalAccountId || !Array.isArray(root.tags)) {
      throw new MercadoLibreCatalogError(
        "INVALID_RESPONSE",
        "Mercado Libre returned invalid seller capabilities.",
      );
    }
    if (!root.tags.includes("user_product_seller")) {
      throw new MercadoLibreCatalogError(
        "PROVIDER_REJECTED",
        "The seller does not have User Products enabled.",
      );
    }
  }

  async uploadPicture(credential: MercadoLibreTokenCredential, source: string): Promise<string> {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      throw new MercadoLibreCatalogError("INVALID_INPUT", "The picture source is not a URL.");
    }
    const loopback = this.allowLoopback && loopbackHosts.has(url.hostname.toLowerCase());
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new MercadoLibreCatalogError(
        "INVALID_INPUT",
        "Picture sources require HTTPS outside loopback.",
      );
    }
    const response = await this.request(credential, "POST", "pictures/items/upload", { source });
    const root = record(parseHttpJson(response.body));
    return externalId(
      stringValue(root.id, "picture id", 160),
      "pictureId",
      /^[A-Za-z0-9_-]{1,160}$/,
    );
  }

  async createItem(
    credential: MercadoLibreTokenCredential,
    input: MercadoLibreCreateItemInput,
  ): Promise<MercadoLibreItemSnapshot> {
    externalId(input.categoryId, "categoryId", /^MCO[0-9]{1,27}$/);
    validateContentInput(input);
    if (!["gold_special", "gold_pro"].includes(input.listingTypeId)) {
      throw new MercadoLibreCatalogError("INVALID_INPUT", "The listing type is invalid.");
    }
    if (
      input.quantity !== undefined &&
      (!Number.isInteger(input.quantity) || input.quantity < 0 || input.quantity > 2_147_483_647)
    ) {
      throw new MercadoLibreCatalogError("INVALID_INPUT", "The stock quantity is invalid.");
    }
    const response = await this.request(credential, "POST", "items", {
      ...(input.userProductId ? { user_product_id: userProductId(input.userProductId) } : {}),
      family_name: input.familyName,
      category_id: input.categoryId,
      currency_id: "COP",
      price: priceNumber(input.priceCents),
      ...(input.quantity !== undefined ? { available_quantity: input.quantity } : {}),
      listing_type_id: input.listingTypeId,
      condition: "new",
      description: { plain_text: input.description },
      pictures: input.pictureIds.map((id) => ({ id })),
      attributes: input.attributes.map((attribute) => ({
        ...(attribute.id ? { id: attribute.id } : {}),
        ...(attribute.name ? { name: attribute.name } : {}),
        value_name: attribute.valueName,
      })),
      shipping: {
        mode: "me2",
        free_shipping: input.priceCents >= 6_000_000n,
        ...(input.fulfillment ? { logistic_type: "fulfillment" } : {}),
      },
    });
    return parseItem(response.body, credential.externalAccountId, {
      ...(input.userProductId ? { userProductId: input.userProductId } : {}),
    });
  }

  async getItem(
    credential: MercadoLibreTokenCredential,
    id: string,
  ): Promise<MercadoLibreItemSnapshot> {
    const response = await this.request(
      credential,
      "GET",
      `items/${encodeURIComponent(itemId(id))}`,
    );
    return parseItem(response.body, credential.externalAccountId, { itemId: id });
  }

  async updateItem(
    credential: MercadoLibreTokenCredential,
    id: string,
    changes: {
      readonly priceCents?: bigint;
      readonly quantity?: number;
      readonly status?: "active" | "paused" | "closed";
      readonly familyName?: string;
      readonly description?: string;
      readonly pictureIds?: readonly string[];
      readonly attributes?: readonly MercadoLibreAttributeInput[];
    },
  ): Promise<MercadoLibreItemSnapshot> {
    validateContentInput(changes);
    if (
      changes.quantity !== undefined &&
      (!Number.isInteger(changes.quantity) ||
        changes.quantity < 0 ||
        changes.quantity > 2_147_483_647)
    ) {
      throw new MercadoLibreCatalogError("INVALID_INPUT", "The stock quantity is invalid.");
    }
    const response = await this.request(
      credential,
      "PUT",
      `items/${encodeURIComponent(itemId(id))}`,
      {
        ...(changes.priceCents !== undefined ? { price: priceNumber(changes.priceCents) } : {}),
        ...(changes.quantity !== undefined ? { available_quantity: changes.quantity } : {}),
        ...(changes.status ? { status: changes.status } : {}),
        ...(changes.familyName ? { family_name: changes.familyName } : {}),
        ...(changes.description ? { description: { plain_text: changes.description } } : {}),
        ...(changes.pictureIds
          ? { pictures: changes.pictureIds.map((pictureId) => ({ id: pictureId })) }
          : {}),
        ...(changes.attributes
          ? {
              attributes: changes.attributes.map((attribute) => ({
                ...(attribute.id ? { id: attribute.id } : {}),
                ...(attribute.name ? { name: attribute.name } : {}),
                value_name: attribute.valueName,
              })),
            }
          : {}),
      },
    );
    return parseItem(response.body, credential.externalAccountId, { itemId: id });
  }

  async getStock(
    credential: MercadoLibreTokenCredential,
    id: string,
  ): Promise<MercadoLibreStockSnapshot | null> {
    try {
      const response = await this.request(
        credential,
        "GET",
        `user-products/${encodeURIComponent(userProductId(id))}/stock`,
      );
      return stockSnapshot(
        response.body,
        response.headers.get("x-version"),
        credential.externalAccountId,
        id,
      );
    } catch (error) {
      if (error instanceof MercadoLibreCatalogError && error.code === "NOT_FOUND") return null;
      throw error;
    }
  }

  async updateWarehouseStock(
    credential: MercadoLibreTokenCredential,
    input: {
      readonly userProductId: string;
      readonly stockVersion: bigint;
      readonly quantity: number;
      readonly storeId: string;
      readonly networkNodeId: string;
      readonly create?: boolean;
    },
  ): Promise<void> {
    quantity(input.quantity);
    if (input.stockVersion < 0n) {
      throw new MercadoLibreCatalogError(
        "INVALID_INPUT",
        "The stock version must be non-negative.",
      );
    }
    await this.request(
      credential,
      input.create ? "POST" : "PUT",
      `user-products/${encodeURIComponent(userProductId(input.userProductId))}/stock/type/seller_warehouse`,
      {
        store_id: externalId(input.storeId, "storeId", /^[A-Za-z0-9_-]{1,64}$/),
        network_node_id: externalId(input.networkNodeId, "networkNodeId", /^[A-Za-z0-9_-]{1,64}$/),
        quantity: input.quantity,
      },
      { "x-version": input.stockVersion.toString() },
    );
  }

  async findItemIdsBySellerSku(
    credential: MercadoLibreTokenCredential,
    sellerSku: string,
  ): Promise<readonly string[]> {
    if (!/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(sellerSku)) {
      throw new MercadoLibreCatalogError("INVALID_INPUT", "The seller SKU has an invalid format.");
    }
    const response = await this.request(
      credential,
      "GET",
      `users/${encodeURIComponent(credential.externalAccountId)}/items/search?seller_sku=${encodeURIComponent(sellerSku)}&limit=50`,
    );
    const root = record(parseHttpJson(response.body));
    if (!Array.isArray(root.results) || root.results.length > 50) {
      throw new MercadoLibreCatalogError(
        "INVALID_RESPONSE",
        "Mercado Libre returned invalid item search results.",
      );
    }
    if (root.paging !== undefined) {
      const paging = record(root.paging);
      if (
        typeof paging.total !== "number" ||
        !Number.isSafeInteger(paging.total) ||
        paging.total !== root.results.length
      ) {
        throw new MercadoLibreCatalogError(
          "INVALID_RESPONSE",
          "The seller SKU search is truncated or inconsistent.",
        );
      }
    }
    const ids = root.results.map((value) => itemId(stringValue(value, "item id", 64)));
    if (new Set(ids).size !== ids.length) {
      throw new MercadoLibreCatalogError(
        "INVALID_RESPONSE",
        "Mercado Libre returned duplicate item IDs.",
      );
    }
    return ids;
  }
}
