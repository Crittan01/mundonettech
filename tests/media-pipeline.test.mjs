import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

import {
  R2MediaStorage,
  inspectImageMagic,
  normalizeStorageKey,
  processImageSafely,
  storeImageDerivatives,
  storeModel3d,
  storeSpin360,
  validateGlb,
  validateUsdz,
} from "../packages/media/dist/index.js";
import { createBmff, createGlb, createPng, createUsdz } from "./helpers/binary-fixtures.mjs";

let server;
let endpoint;
let requests;
let failWebp = false;
let failDelete = false;

before(async () => {
  requests = [];
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });
    if (failWebp && request.url?.includes("/640.webp")) {
      response.writeHead(500, { "Content-Type": "text/plain" }).end("intentional storage failure");
      return;
    }
    if (failDelete && request.method === "DELETE") {
      response.writeHead(500, { "Content-Type": "text/plain" }).end("intentional cleanup failure");
      return;
    }
    if (request.method === "POST" && request.url?.includes("uploads")) {
      response
        .writeHead(200, { "Content-Type": "application/xml" })
        .end(
          "<InitiateMultipartUploadResult><UploadId>test-upload</UploadId></InitiateMultipartUploadResult>",
        );
      return;
    }
    if (request.method === "POST") {
      response
        .writeHead(200, { "Content-Type": "application/xml" })
        .end(
          '<CompleteMultipartUploadResult><ETag>"test-etag"</ETag></CompleteMultipartUploadResult>',
        );
      return;
    }
    response.writeHead(200, { ETag: '"test-etag"' }).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

function storage() {
  return new R2MediaStorage({
    endpoint,
    publicBaseUrl: endpoint,
    bucket: "media-test",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
  });
}

describe("F1.2 — safe image inspection and real derivatives", () => {
  it("detects JPEG/PNG/WebP and parses nested HEIC/AVIF ispe dimensions", () => {
    assert.equal(inspectImageMagic(createPng()).format, "png");
    assert.equal(inspectImageMagic(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).format, "jpeg");
    assert.equal(inspectImageMagic(Buffer.from("RIFF0000WEBP", "ascii")).format, "webp");
    const heic = inspectImageMagic(createBmff());
    assert.equal(heic.format, "heic");
    assert.equal(heic.bmffWidth, 320);
    assert.equal(heic.bmffHeight, 200);
    assert.equal(inspectImageMagic(createBmff(640, 480, "avif")).format, "avif");
  });

  it("rejects SVG, unknown binary, malformed BMFF and oversized ispe before decode", () => {
    for (const input of [
      Buffer.from("<svg><script>alert(1)</script></svg>"),
      Buffer.alloc(32),
      createBmff(20_000, 20_000),
      createBmff(10, 10, "heic", false),
      createBmff(10, 10, "unknown"),
    ]) {
      assert.throws(() => inspectImageMagic(input));
    }
    assert.throws(() => inspectImageMagic(createPng(), { maxBytes: 0 }), RangeError);
  });

  it("creates deduplicated AVIF/WebP derivatives and strips EXIF/GPS", async () => {
    const result = await processImageSafely(createPng(640, 480, true), {
      widths: [320, 640, 1920],
    });
    assert.equal(result.sourceWidth, 640);
    assert.equal(result.derivatives.length, 4);
    assert.deepEqual([...new Set(result.derivatives.map((item) => item.width))], [320, 640]);
    assert.deepEqual([...new Set(result.derivatives.map((item) => item.format))].sort(), [
      "avif",
      "webp",
    ]);
    for (const derivative of result.derivatives) {
      assert.equal(derivative.height, derivative.width === 320 ? 240 : 480);
      assert.equal(derivative.byteSize, derivative.bytes.length);
      assert.equal(Buffer.from(derivative.bytes).includes(Buffer.from("GPS-test-metadata")), false);
    }
  });

  it("rejects dimensions above the decoded pixel budget", async () => {
    await assert.rejects(processImageSafely(createPng(100, 100), { maxPixels: 1000 }));
    await assert.rejects(processImageSafely(createPng(), { widths: [0] }), RangeError);
  });
});

describe("F1.2 — GLB and USDZ binary safety", () => {
  it("accepts valid embedded GLB 2 and rejects external/out-of-bounds resources", () => {
    assert.equal(validateGlb(createGlb()).kind, "glb");
    for (const input of [
      createGlb({ version: 1 }),
      createGlb({ declaredLength: 10 }),
      createGlb({ externalUri: "https://example.com/buffer.bin" }),
      createGlb({ imageUri: "file:///etc/passwd" }),
      createGlb({ viewLength: 100 }),
      Buffer.from("not-glb"),
    ]) {
      assert.throws(() => validateGlb(input));
    }
  });

  it("accepts valid USDZ and validates paths, types, ratio and actual sizes in streaming", async () => {
    const valid = createUsdz([
      { name: "model.usdc", data: Buffer.from("USDC-real-model-data") },
      { name: "texture.png", data: createPng(32, 32) },
    ]);
    const result = await validateUsdz(valid);
    assert.equal(result.kind, "usdz");
    assert.equal(result.entryCount, 2);
    assert.ok(result.uncompressedBytes > 0);
    await assert.rejects(
      validateUsdz(createUsdz([{ name: "../escape.png", data: Buffer.from("bad") }])),
    );
    await assert.rejects(
      validateUsdz(createUsdz([{ name: "payload.txt", data: Buffer.from("bad") }])),
    );
    await assert.rejects(
      validateUsdz(
        createUsdz([{ name: "model.usdc", data: Buffer.alloc(1024 * 1024, 0), method: 8 }]),
      ),
    );
    await assert.rejects(
      validateUsdz(
        createUsdz([{ name: "model.usdc", data: Buffer.from("actual-data"), uncompressedSize: 2 }]),
      ),
    );
  });
});

describe("F1.2 — R2 S3-compatible persistence and rollback", () => {
  it("uploads content-addressed derivatives with immutable cache metadata", async () => {
    requests.length = 0;
    const client = storage();
    try {
      const stored = await storeImageDerivatives(client, createPng(), "products/image", [320]);
      assert.equal(stored.length, 4);
      assert.ok(stored.every((item) => item.publicUrl?.startsWith(endpoint)));
      const writes = requests.filter((request) => request.method === "PUT");
      assert.equal(writes.length, 4);
      assert.ok(writes.every((request) => request.url?.startsWith("/media-test/products/image/")));
      assert.ok(
        writes.every(
          (request) => request.headers["cache-control"] === "public,max-age=31536000,immutable",
        ),
      );
      assert.ok(writes.some((request) => request.headers["content-type"] === "image/avif"));
      assert.ok(writes.some((request) => request.headers["content-type"] === "image/webp"));
    } finally {
      await client.destroy();
    }
  });

  it("deletes all successful partial uploads when a derivative fails", async () => {
    requests.length = 0;
    failWebp = true;
    const client = storage();
    try {
      await assert.rejects(
        storeImageDerivatives(client, createPng(), "products/failure", [320, 640]),
      );
      const deletes = requests.filter((request) => request.method === "DELETE");
      assert.equal(deletes.length, 3);
    } finally {
      failWebp = false;
      await client.destroy();
    }
  });

  it("preserves both errors when upload rollback cannot delete partial objects", async () => {
    requests.length = 0;
    failWebp = true;
    failDelete = true;
    const client = storage();
    try {
      await assert.rejects(
        storeImageDerivatives(client, createPng(), "products/cleanup-failure", [320, 640]),
        (error) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.errors.length, 2);
          assert.match(error.message, /upload and cleanup both failed/);
          return true;
        },
      );
      assert.ok(requests.some((request) => request.method === "DELETE"));
    } finally {
      failWebp = false;
      failDelete = false;
      await client.destroy();
    }
  });

  it("uses real S3 multipart uploads above 8 MiB", async () => {
    requests.length = 0;
    const client = storage();
    try {
      const stored = await client.put({
        key: "products/large/model.glb",
        body: new Uint8Array(8 * 1024 * 1024 + 1),
        contentType: "model/gltf-binary",
      });
      assert.equal(stored.byteSize, 8 * 1024 * 1024 + 1);
      const parts = requests.filter(
        (request) => request.method === "PUT" && request.url?.includes("partNumber="),
      );
      assert.equal(parts.length, 2);
      assert.deepEqual(
        parts.map((part) => part.body.length).sort((a, b) => a - b),
        [1, 8 * 1024 * 1024],
      );
      assert.ok(requests.some((request) => request.url?.includes("uploads")));
      assert.ok(
        requests.some(
          (request) => request.method === "POST" && request.url?.includes("uploadId=test-upload"),
        ),
      );
    } finally {
      await client.destroy();
    }
  });

  it("persists ordered SPIN_360 frames and validated GLB/USDZ models", async () => {
    requests.length = 0;
    const client = storage();
    try {
      const frames = await storeSpin360(
        client,
        [createPng(320, 240), createPng(320, 240)],
        "products/spin",
        [320],
      );
      assert.equal(frames.length, 2);
      assert.equal(frames[0].derivatives.length, 2);
      const glb = await storeModel3d(client, createGlb(), "glb", "products/model");
      assert.equal(glb.contentType, "model/gltf-binary");
      const usdz = createUsdz([{ name: "model.usdc", data: Buffer.from("USDC-model") }]);
      const storedUsdz = await storeModel3d(client, usdz, "usdz", "products/model");
      assert.equal(storedUsdz.contentType, "model/vnd.usdz+zip");
    } finally {
      await client.destroy();
    }
  });

  it("rejects non-HTTPS endpoints outside loopback and unsafe storage keys", () => {
    assert.throws(
      () =>
        new R2MediaStorage({
          endpoint: "http://example.com",
          bucket: "media-test",
          accessKeyId: "a",
          secretAccessKey: "b",
        }),
    );
    for (const key of ["../secret", "/absolute", "a//b", "a\\b", "a/\0b"])
      assert.throws(() => normalizeStorageKey(key));
  });
});
