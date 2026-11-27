import { beforeEach, describe, expect, it, vi } from "vitest";

import { connection } from "./next-server-stub";
import { expectMethodAllowlist, expectNoStoreNoIndex } from "./test-helpers";

const mocks = vi.hoisted(() => ({
  connection: vi.fn(),
  executeRaw: vi.fn(),
  getGoogleMerchantFeed: vi.fn(),
  getMetaCatalogFeed: vi.fn(),
  getSitemapPartitions: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDatabase: () => ({
    $transaction: async <T>(
      callback: (tx: {
        $executeRaw: typeof mocks.executeRaw;
        $queryRaw: typeof mocks.queryRaw;
      }) => Promise<T>,
    ) => callback({ $executeRaw: mocks.executeRaw, $queryRaw: mocks.queryRaw }),
  }),
}));
vi.mock("@/lib/seo-data", () => ({
  getGoogleMerchantFeed: mocks.getGoogleMerchantFeed,
  getMetaCatalogFeed: mocks.getMetaCatalogFeed,
  getSitemapPartitions: mocks.getSitemapPartitions,
}));

import * as googleRoute from "../../apps/web/app/api/feeds/google-merchant/route";
import * as metaRoute from "../../apps/web/app/api/feeds/meta-catalog/route";
import * as liveRoute from "../../apps/web/app/api/health/live/route";
import * as readyRoute from "../../apps/web/app/api/health/ready/route";
import * as sitemapRoute from "../../apps/web/app/sitemap.xml/route";
import * as partitionRoute from "../../apps/web/app/sitemaps/[id]/route";

connection.mockImplementation(mocks.connection);

const readyRow = {
  serverVersion: 170_200,
  appliedMigrations: 20,
  unfinishedMigrations: 0,
  rlsTriggerEnabled: true,
};

function partitionRequest(id: string): Promise<Response> {
  return partitionRoute.GET(new Request("https://mundonettech.co/sitemaps/0.xml"), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connection.mockResolvedValue(undefined);
  mocks.getSitemapPartitions.mockResolvedValue([[{ url: "https://mundonettech.co/productos" }]]);
  mocks.queryRaw.mockResolvedValue([readyRow]);
});

describe("sitemap routes", () => {
  it("renders a single partition without an HTTP shared cache", async () => {
    const response = await sitemapRoute.GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expectNoStoreNoIndex(response);
    expect(await response.text()).toContain("<loc>https://mundonettech.co/productos</loc>");
  });

  it("uses canonical child URLs when partitioned", async () => {
    mocks.getSitemapPartitions.mockResolvedValue([
      [{ url: "https://mundonettech.co/productos" }],
      [{ url: "https://mundonettech.co/legal" }],
    ]);
    const response = await sitemapRoute.GET();
    const xml = await response.text();
    expect(xml).toContain("<loc>https://mundonettech.co/sitemaps/0.xml</loc>");
    expect(xml).toContain("<loc>https://mundonettech.co/sitemaps/1.xml</loc>");
  });

  it("returns only the selected real partition", async () => {
    mocks.getSitemapPartitions.mockResolvedValue([
      [{ url: "https://mundonettech.co/productos" }],
      [{ url: "https://mundonettech.co/legal" }],
    ]);
    const response = await partitionRequest("1.xml");
    expect(response.status).toBe(200);
    const xml = await response.text();
    expect(xml).toContain("<loc>https://mundonettech.co/legal</loc>");
    expect(xml).not.toContain("<loc>https://mundonettech.co/productos</loc>");
  });

  it.each(["00.xml", "01.xml", "1000000.xml", "not-a-number.xml", "-1.xml"])(
    "rejects malformed or non-canonical id %s before reading partitions",
    async (id) => {
      const response = await partitionRequest(id);
      expect(response.status).toBe(404);
      expectNoStoreNoIndex(response);
      expect(mocks.getSitemapPartitions).not.toHaveBeenCalled();
    },
  );

  it("bounds numeric input before conversion or database work", async () => {
    const response = await partitionRequest(`${"9".repeat(100_000)}.xml`);
    expect(response.status).toBe(404);
    expect(mocks.getSitemapPartitions).not.toHaveBeenCalled();
  });

  it("returns a hardened 404 for an absent bounded partition", async () => {
    const response = await partitionRequest("999999.xml");
    expect(response.status).toBe(404);
    expectNoStoreNoIndex(response);
    expect(mocks.getSitemapPartitions).toHaveBeenCalledOnce();
  });

  it("returns neutral 500 responses when sitemap data cannot be read", async () => {
    mocks.getSitemapPartitions.mockRejectedValue(new Error("private database details"));
    const index = await sitemapRoute.GET();
    const partition = await partitionRequest("0.xml");
    expect(index.status).toBe(500);
    expect(partition.status).toBe(500);
    expectNoStoreNoIndex(index);
    expectNoStoreNoIndex(partition);
    expect(await index.text()).toBe("Sitemap unavailable.");
    expect(await partition.text()).toBe("Sitemap unavailable.");
  });

  it("rejects every method outside GET without reading data", async () => {
    await expectMethodAllowlist(sitemapRoute);
    await expectMethodAllowlist(partitionRoute);
    expect(mocks.getSitemapPartitions).not.toHaveBeenCalled();
  });
});

describe("public catalog feeds", () => {
  it("returns the real Merchant XML with nosniff and no synthetic fields", async () => {
    const xml = "<rss><g:id>variant-1</g:id><g:price>1000.00 COP</g:price></rss>";
    mocks.getGoogleMerchantFeed.mockResolvedValue(xml);
    const response = await googleRoute.GET();
    expect(response.status).toBe(200);
    expectNoStoreNoIndex(response);
    expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(await response.text()).toBe(xml);
  });

  it("returns neutralized service CSV and aggregate diagnostics only", async () => {
    mocks.getMetaCatalogFeed.mockResolvedValue({
      csv: 'id,title,price\r\nvariant-1,"\'=formula",1000.00 COP\r\n',
      accepted: 1,
      excluded: 1,
      issues: [
        { id: "internal-variant-id", code: "MISSING_IMAGE" },
        { id: "variant-1", code: "INVALID_GTIN" },
      ],
    });
    const response = await metaRoute.GET();
    expect(response.status).toBe(200);
    expectNoStoreNoIndex(response);
    expect(response.headers.get("x-meta-catalog-items")).toBe("1");
    expect(response.headers.get("x-meta-catalog-exclusions")).toBe("1");
    expect(response.headers.get("content-disposition")).toBe('inline; filename="meta-catalog.csv"');
    const csv = await response.text();
    expect(csv).toContain('"\'=formula"');
    expect(csv).not.toContain("internal-variant-id");
  });

  it("returns neutral 500 responses when feed generation fails", async () => {
    mocks.getGoogleMerchantFeed.mockRejectedValue(new Error("private merchant failure"));
    mocks.getMetaCatalogFeed.mockRejectedValue(new Error("private meta failure"));
    const google = await googleRoute.GET();
    const meta = await metaRoute.GET();
    expect(google.status).toBe(500);
    expect(meta.status).toBe(500);
    expectNoStoreNoIndex(google);
    expectNoStoreNoIndex(meta);
    expect(await google.text()).toBe("Feed unavailable.");
    expect(await meta.text()).toBe("Feed unavailable.");
  });

  it("rejects mutations and automatic HEAD fallback without reading feeds", async () => {
    await expectMethodAllowlist(googleRoute);
    await expectMethodAllowlist(metaRoute);
    expect(mocks.getGoogleMerchantFeed).not.toHaveBeenCalled();
    expect(mocks.getMetaCatalogFeed).not.toHaveBeenCalled();
  });
});

describe("health probes", () => {
  it("keeps liveness minimal and dynamic", async () => {
    const response = await liveRoute.GET();
    expect(response.status).toBe(200);
    expectNoStoreNoIndex(response);
    expect(await response.json()).toEqual({ status: "alive" });
    expect(mocks.connection).toHaveBeenCalledOnce();
  });

  it("requires PostgreSQL 17, applied migrations, bounded statement_timeout and enabled RLS enforcement", async () => {
    const response = await readyRoute.GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
    const timeoutSql = String(mocks.executeRaw.mock.calls[0]?.[0]?.join("?"));
    expect(timeoutSql).toContain("SET LOCAL statement_timeout = '3000'");
    const sql = String(mocks.queryRaw.mock.calls[0]?.[0]?.join("?"));
    expect(sql).toContain("evtenabled IN ('O', 'A')");
    expect(sql).not.toContain("evtenabled <> 'D'");
    const headLive = await liveRoute.HEAD();
    expect(headLive.status).toBe(405);
    expect(await headLive.text()).toBe("");
    const headReady = await readyRoute.HEAD();
    expect(headReady.status).toBe(405);
    expect(await headReady.text()).toBe("");
  });

  it.each([
    { rows: [] },
    { rows: [{ ...readyRow, serverVersion: 160_006 }] },
    { rows: [{ ...readyRow, serverVersion: 180_000 }] },
    { rows: [{ ...readyRow, appliedMigrations: 0 }] },
    { rows: [{ ...readyRow, unfinishedMigrations: 1 }] },
    { rows: [{ ...readyRow, rlsTriggerEnabled: false }] },
  ])("fails closed without exposing readiness internals", async ({ rows }) => {
    mocks.queryRaw.mockResolvedValue(rows);
    const response = await readyRoute.GET();
    expect(response.status).toBe(503);
    expectNoStoreNoIndex(response);
    expect(await response.json()).toEqual({ status: "unavailable" });
  });

  it("logs only an error class when readiness fails and enforces bounded transaction timeouts", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.queryRaw.mockRejectedValue(new Error("postgresql://user:secret@internal/db"));
    const response = await readyRoute.GET();
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
    expect(consoleError).toHaveBeenCalledWith("Database readiness check failed.", "Error");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("secret");

    vi.useFakeTimers();
    try {
      mocks.queryRaw.mockImplementation(() => new Promise(() => undefined));
      const pending = readyRoute.GET();
      await vi.advanceTimersByTimeAsync(3_100);
      const timedOut = await pending;
      expect(timedOut.status).toBe(503);
      expect(await timedOut.json()).toEqual({ status: "unavailable" });
    } finally {
      vi.useRealTimers();
    }
    consoleError.mockRestore();
  });

  it("rejects unsupported methods without touching infrastructure", async () => {
    await expectMethodAllowlist(liveRoute);
    await expectMethodAllowlist(readyRoute);
    expect(mocks.connection).not.toHaveBeenCalled();
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });
});
