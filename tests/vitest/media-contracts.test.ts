import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildPictureSources,
  buildSpinFrames,
  isSafeMediaUrl,
  isSafeSrcSet,
} from "../../packages/media/dist/responsive-sources.js";

describe("F1.2 — client viewer subpath isolation and responsive URL contracts", () => {
  it("keeps @mundonettech/media/viewers free of server-only sharp, S3, yauzl, and Node core imports", () => {
    const viewersEntry = readFileSync(
      path.resolve(process.cwd(), "packages/media/dist/viewers.js"),
      "utf8",
    );
    const spinEntry = readFileSync(
      path.resolve(process.cwd(), "packages/media/dist/spin-360.js"),
      "utf8",
    );
    const modelEntry = readFileSync(
      path.resolve(process.cwd(), "packages/media/dist/model-3d.js"),
      "utf8",
    );
    const responsiveEntry = readFileSync(
      path.resolve(process.cwd(), "packages/media/dist/responsive-sources.js"),
      "utf8",
    );

    for (const source of [viewersEntry, spinEntry, modelEntry, responsiveEntry]) {
      expect(source).not.toMatch(/\b(?:sharp|yauzl|@aws-sdk|node:)\b/);
    }
  });

  it("enforces strict HTTPS/loopback/root-relative URLs and descriptor srcSet rules", () => {
    expect(isSafeMediaUrl("https://cdn.mundonettech.co/products/1/640.avif")).toBe(true);
    expect(isSafeMediaUrl("http://127.0.0.1:4110/local.webp")).toBe(true);
    expect(isSafeMediaUrl("/media/local.avif")).toBe(true);

    for (const unsafe of [
      "",
      "   ",
      "//evil.example/protocol-relative.avif",
      "/\\backslash.avif",
      "http://remote-http.example/file.avif",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
    ]) {
      expect(isSafeMediaUrl(unsafe)).toBe(false);
    }

    expect(
      isSafeSrcSet(
        "https://cdn.example.test/320.avif 320w, https://cdn.example.test/640.avif 640w",
      ),
    ).toBe(true);
    expect(isSafeSrcSet("javascript:alert(1) 1x")).toBe(false);
    expect(isSafeSrcSet("https://cdn.example.test/320.avif invalid-descriptor")).toBe(false);
  });

  it("builds ordered AVIF/WebP picture sources and rejects empty or unsafe inputs", () => {
    const picture = buildPictureSources(
      [
        { format: "webp", width: 1280, height: 960, key: "items/a/1280.webp" },
        { format: "avif", width: 480, height: 360, key: "items/a/480.avif" },
        { format: "avif", width: 1280, height: 960, key: "items/a/1280.avif" },
        { format: "webp", width: 480, height: 360, key: "items/a/480.webp" },
      ],
      { baseUrl: "https://media.mundonettech.co/", sizes: "(max-width: 768px) 100vw, 50vw" },
    );

    expect(picture.src).toBe("https://media.mundonettech.co/items/a/1280.webp");
    expect(picture.width).toBe(1280);
    expect(picture.height).toBe(960);
    expect(picture.sources).toEqual([
      {
        type: "image/avif",
        srcSet:
          "https://media.mundonettech.co/items/a/480.avif 480w, https://media.mundonettech.co/items/a/1280.avif 1280w",
        sizes: "(max-width: 768px) 100vw, 50vw",
      },
      {
        type: "image/webp",
        srcSet:
          "https://media.mundonettech.co/items/a/480.webp 480w, https://media.mundonettech.co/items/a/1280.webp 1280w",
        sizes: "(max-width: 768px) 100vw, 50vw",
      },
    ]);

    expect(() => buildPictureSources([])).toThrow(RangeError);
    expect(() =>
      buildPictureSources([
        { format: "avif", width: 480, height: 360, publicUrl: "http://evil.example/480.avif" },
      ]),
    ).toThrow(TypeError);
    expect(() => buildSpinFrames([{ frame: 0, derivatives: [] }])).toThrow(RangeError);
  });
});
