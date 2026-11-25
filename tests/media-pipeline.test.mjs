import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

import {
  R2MediaStorage,
  buildSpinFrames,
  inspectImageMagic,
  normalizeStorageKey,
  processImageSafely,
  storeImageDerivatives,
  storeModel3d,
  storeSpin360,
  validateGlb,
  validateUsdz,
} from "../packages/media/dist/index.js";
import {
  bmffBox,
  createBmff,
  createGlb,
  createPng,
  createPngHeaderOnly,
  createUsdz,
  createWebpVp8xHeader,
} from "./helpers/binary-fixtures.mjs";

let server;
let endpoint;
let requests;
let failWebp = false;
let failSpinFrame2 = false;
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
    if (
      failSpinFrame2 &&
      request.url?.includes("/frame-002/") &&
      request.url?.includes("/320.webp")
    ) {
      response.writeHead(500, { "Content-Type": "text/plain" }).end("intentional frame 2 failure");
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
  it("detects JPEG/PNG/WebP and parses ISO-BMFF HEIC/AVIF ispe and compatible brands", () => {
    assert.equal(inspectImageMagic(createPng()).format, "png");
    assert.equal(inspectImageMagic(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).format, "jpeg");
    assert.equal(inspectImageMagic(Buffer.from("RIFF0000WEBP", "ascii")).format, "webp");
    assert.equal(inspectImageMagic(createWebpVp8xHeader(800, 600)).format, "webp");

    const heic = inspectImageMagic(createBmff(320, 200, "heic"));
    assert.equal(heic.format, "heic");
    assert.equal(heic.bmffWidth, 320);
    assert.equal(heic.bmffHeight, 200);

    // Thumbnail ispe after primary ispe must not mask primary dimensions
    const multiIspe = inspectImageMagic(
      createBmff(1280, 960, "heic", true, { extraIspes: [{ width: 64, height: 64 }] }),
    );
    assert.equal(multiIspe.bmffWidth, 1280);
    assert.equal(multiIspe.bmffHeight, 960);

    // mif1/miaf major brand with avif in compatible_brands classifies as avif
    const mif1Avif = inspectImageMagic(
      createBmff(640, 480, "mif1", true, { compatibleBrands: ["mif1", "miaf", "avif"] }),
    );
    assert.equal(mif1Avif.format, "avif");
    assert.equal(inspectImageMagic(createBmff(640, 480, "avif")).format, "avif");
  });

  it("rejects SVG, GIF/TIFF, malformed BMFF, deep BMFF nesting, and oversized headers before decode", () => {
    let nestedMeta = bmffBox("ispe", Buffer.alloc(12));
    for (let depth = 0; depth < 10; depth += 1) {
      nestedMeta = bmffBox("meta", Buffer.concat([Buffer.alloc(4), nestedMeta]));
    }
    const ftyp = bmffBox(
      "ftyp",
      Buffer.concat([Buffer.from("avif", "ascii"), Buffer.alloc(4), Buffer.from("avif", "ascii")]),
    );

    for (const input of [
      Buffer.from("<svg><script>alert(1)</script></svg>"),
      Buffer.from("GIF89a\x01\x00\x01\x00\x00\xff\x00,", "binary"),
      Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]),
      Buffer.alloc(32),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
      createPngHeaderOnly(25_000, 25_000),
      createWebpVp8xHeader(25_000, 25_000),
      createBmff(20_000, 20_000),
      createBmff(320, 200, "heic", true, { extraIspes: [{ width: 20_000, height: 20_000 }] }),
      createBmff(10, 10, "heic", false),
      createBmff(10, 10, "mp42"),
      Buffer.concat([ftyp, nestedMeta]),
    ]) {
      assert.throws(() => inspectImageMagic(input));
    }
    assert.throws(() => inspectImageMagic(createPng(), { maxBytes: 0 }), RangeError);
  });

  it("creates deduplicated AVIF/WebP derivatives, strips EXIF/GPS, and round-trips real AVIF/WebP", async () => {
    const result = await processImageSafely(createPng(640, 480, true, 1), {
      widths: [320, 640, 1920],
    });
    assert.equal(result.sourceWidth, 640);
    assert.equal(result.sourceHeight, 480);
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
      // Real libheif/libwebp output must pass inspectImageMagic and processImageSafely round-trip
      const reinspected = inspectImageMagic(derivative.bytes);
      assert.equal(reinspected.format, derivative.format);
      if (derivative.format === "avif") {
        assert.equal(reinspected.bmffWidth, derivative.width);
        assert.equal(reinspected.bmffHeight, derivative.height);
      }
    }

    const realAvif = result.derivatives.find((d) => d.format === "avif" && d.width === 640);
    const reencoded = await processImageSafely(realAvif.bytes, { widths: [320] });
    assert.equal(reencoded.sourceWidth, 640);
    assert.equal(reencoded.derivatives.length, 4);
  });

  it("auto-orients EXIF Orientation=6 portrait images without duplicate widths or aspect distortion", async () => {
    // Raw sensor 640x480 with EXIF Orientation=6 (90° CW) becomes 480x640 portrait
    const portrait = await processImageSafely(createPng(640, 480, true, 6), {
      widths: [320, 480, 640, 1280],
    });
    assert.equal(portrait.sourceWidth, 480);
    assert.equal(portrait.sourceHeight, 640);
    assert.deepEqual(
      portrait.derivatives.map((d) => `${d.width}x${d.height}.${d.format}`),
      ["320x427.avif", "320x427.webp", "480x640.avif", "480x640.webp"],
    );
  });

  it("rejects dimensions above the decoded pixel budget and invalid derivative widths", async () => {
    await assert.rejects(processImageSafely(createPng(100, 100), { maxPixels: 1000 }));
    await assert.rejects(processImageSafely(createPng(), { widths: [0] }), RangeError);
  });
});

describe("F1.2 — GLB and USDZ binary safety", () => {
  it("accepts valid embedded GLB 2 and rejects external URIs, Draco/Meshopt, and out-of-bounds views", () => {
    assert.equal(validateGlb(createGlb()).kind, "glb");
    for (const input of [
      createGlb({ version: 1 }),
      createGlb({ omitAsset: true }),
      createGlb({ assetVersion: "1.0" }),
      createGlb({ declaredLength: 10 }),
      createGlb({ binaryLength: 3 }),
      createGlb({ omitBinChunk: true }),
      createGlb({ externalUri: "https://example.com/buffer.bin" }),
      createGlb({ imageUri: "file:///etc/passwd" }),
      createGlb({ extras: { nested: { uri: "https://evil.example/ssrf" } } }),
      createGlb({ extensionsRequired: ["KHR_draco_mesh_compression"] }),
      createGlb({ extensionsRequired: ["EXT_meshopt_compression"] }),
      createGlb({ extensionsUsed: ["KHR_draco_mesh_compression"] }),
      createGlb({ extensionsUsed: ["EXT_meshopt_compression"] }),
      createGlb({ accessors: [{ bufferView: 99 }] }),
      createGlb({ accessors: [{ bufferView: 0, byteOffset: -1 }] }),
      createGlb({ accessors: [{ bufferView: 0, byteOffset: 4 }] }),
      createGlb({ accessors: [null] }),
      createGlb({
        accessors: [
          {
            bufferView: 0,
            sparse: { indices: { bufferView: 99 }, values: { bufferView: 0 } },
          },
        ],
      }),
      createGlb({
        rawDocument: {
          asset: { version: "2.0" },
          buffers: [{ byteLength: 4 }],
          bufferViews: [{ buffer: 0, byteLength: 4 }],
          meshes: [{ primitives: [{ extensions: { KHR_draco_mesh_compression: {} } }] }],
        },
      }),
      createGlb({
        rawDocument: {
          asset: { version: "2.0" },
          buffers: [{ byteLength: 4 }],
          bufferViews: [{ buffer: 0, byteLength: 4, extensions: { EXT_meshopt_compression: {} } }],
        },
      }),
      createGlb({ viewLength: 100 }),
      Buffer.from("not-glb"),
    ]) {
      assert.throws(() => validateGlb(input));
    }
  });

  it("accepts valid USDZ and blocks traversal, symlinks, spoofed textures, dotless files, and bombs", async () => {
    const valid = createUsdz([
      { name: "model.usdc", data: Buffer.from("PXR-USDC\0\0\0\0real-model-data") },
      { name: "textures/albedo.png", data: createPng(32, 32) },
    ]);
    const result = await validateUsdz(valid);
    assert.equal(result.kind, "usdz");
    assert.equal(result.entryCount, 2);
    assert.ok(result.uncompressedBytes > 0);

    // Legitimate .usda root stage + AVIF texture larger than 64 KiB
    const largeAvifHeader = createBmff(64, 64, "avif");
    const mdatPayload = Buffer.alloc(70_000, 0xaa);
    const mdatHeader = Buffer.alloc(8);
    mdatHeader.writeUInt32BE(8 + mdatPayload.length, 0);
    mdatHeader.write("mdat", 4, "ascii");
    const largeAvif = Buffer.concat([largeAvifHeader, mdatHeader, mdatPayload]);
    const validUsdaWithLargeAvif = createUsdz([
      { name: "scene.usda", data: Buffer.from("#usda 1.0\n(\n)\n") },
      { name: "textures/hero.avif", data: largeAvif },
    ]);
    const avifResult = await validateUsdz(validUsdaWithLargeAvif);
    assert.equal(avifResult.kind, "usdz");

    for (const invalidArchive of [
      createUsdz([{ name: "../escape.png", data: createPng(16, 16) }]),
      createUsdz([{ name: "C:model.usdc", data: Buffer.from("PXR-USDC-data") }]),
      createUsdz([{ name: ".hidden.usdc", data: Buffer.from("PXR-USDC-data") }]),
      createUsdz([{ name: "usdc", data: Buffer.from("PXR-USDC-dotless") }]),
      createUsdz([{ name: "model.usdc", data: Buffer.from("NOT-USD-MAGIC") }]),
      createUsdz([{ name: "model.usda", data: Buffer.from("not-usda-header") }]),
      createUsdz([
        { name: "model.usdc", data: Buffer.from("PXR-USDC-model") },
        { name: "evil.constructor", data: Buffer.from("prototype-lookup") },
      ]),
      createUsdz([
        { name: "texture.png", data: createPng(16, 16) },
        { name: "model.usdc", data: Buffer.from("PXR-USDC-not-root") },
      ]),
      createUsdz([
        { name: "model.usdc", data: Buffer.from("PXR-USDC-model") },
        { name: "spoofed.png", data: Buffer.from("<svg onload=alert(1)>") },
      ]),
      createUsdz([
        {
          name: "model.usdc",
          data: Buffer.from("/etc/passwd"),
          externalAttributes: (0o120777 << 16) >>> 0,
        },
      ]),
      createUsdz([{ name: "payload.txt", data: Buffer.from("bad") }]),
      createUsdz([
        { name: "textures/", data: Buffer.alloc(0) },
        { name: "model.usdc", data: Buffer.from("PXR-USDC-model") },
      ]),
      createUsdz([{ name: "nested/model.usdc", data: Buffer.from("PXR-USDC-model") }]),
      createUsdz([{ name: "model.usdc", data: Buffer.from("PXR-USDC-model"), flags: 0x40 }]),
      createUsdz([{ name: "model.usdc", data: Buffer.from("PXR-USDC-model"), flags: 0x2000 }]),
      createUsdz([{ name: "model.usdc", data: Buffer.alloc(1024 * 1024, 0), method: 8 }]),
      createUsdz([{ name: "model.usdc", data: Buffer.from("PXR-USDC-data"), uncompressedSize: 2 }]),
      createUsdz([
        {
          name: "model.usdc",
          data: Buffer.from("PXR-USDC-zero-comp"),
          compressedSize: 0,
          uncompressedSize: 18,
        },
      ]),
    ]) {
      await assert.rejects(validateUsdz(invalidArchive));
    }
  });
});

describe("F1.2 — R2 S3-compatible persistence and rollback", () => {
  it("uploads content-addressed derivatives with immutable cache metadata and fails fast on bad prefix", async () => {
    requests.length = 0;
    const client = storage();
    try {
      await assert.rejects(
        storeImageDerivatives(client, Buffer.from("not-even-decoded"), "../invalid-prefix", [320]),
        TypeError,
      );
      assert.equal(requests.length, 0);

      const stored = await storeImageDerivatives(client, createPng(), "products/image/", [320]);
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

  it("deletes all successful partial uploads when a derivative or later SPIN_360 frame fails", async () => {
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
    }

    requests.length = 0;
    failSpinFrame2 = true;
    try {
      await assert.rejects(
        storeSpin360(
          client,
          [createPng(320, 240), createPng(320, 240)],
          "products/spin-fail",
          [320],
        ),
      );
      const deletes = requests.filter((request) => request.method === "DELETE");
      // Frame 1 uploaded 2 derivatives + Frame 2 uploaded 1 AVIF before WebP failed = 3 deleted objects
      assert.equal(deletes.length, 3);
    } finally {
      failSpinFrame2 = false;
      await client.destroy();
    }
  });

  it("preserves all errors when upload rollback cannot delete partial objects", async () => {
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

  it("persists ordered SPIN_360 frames, builds AVIF/WebP SpinFrames, and stores GLB/USDZ models", async () => {
    requests.length = 0;
    const client = storage();
    try {
      const frames = await storeSpin360(
        client,
        [createPng(640, 480), createPng(640, 480)],
        "products/spin",
        [320, 640],
      );
      assert.equal(frames.length, 2);
      assert.equal(frames[0].derivatives.length, 4);
      const spinFrames = buildSpinFrames(frames, { sizes: "(max-width: 768px) 100vw, 640px" });
      assert.equal(spinFrames.length, 2);
      assert.equal(spinFrames[0].width, 640);
      assert.equal(spinFrames[0].height, 480);
      assert.deepEqual(
        spinFrames[0].sources?.map((s) => s.type),
        ["image/avif", "image/webp"],
      );

      const glb = await storeModel3d(client, createGlb(), "glb", "products/model");
      assert.equal(glb.contentType, "model/gltf-binary");
      const usdz = createUsdz([{ name: "model.usdc", data: Buffer.from("PXR-USDC-model") }]);
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
    for (const key of ["../secret", "/absolute", "trailing/", "a//b", "a\\b", "a/\0b"]) {
      assert.throws(() => normalizeStorageKey(key));
    }
  });
});
