import assert from "node:assert/strict";
import { describe, it } from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Model3d, Spin360, buildSpinFrames } from "../packages/media/dist/viewers.js";

const frames = [
  {
    src: "https://cdn.example.test/frame-1.webp",
    sources: [
      {
        srcSet:
          "https://cdn.example.test/frame-1-320.avif 320w, https://cdn.example.test/frame-1-640.avif 640w",
        type: "image/avif",
      },
      {
        srcSet:
          "https://cdn.example.test/frame-1-320.webp 320w, https://cdn.example.test/frame-1-640.webp 640w",
        type: "image/webp",
      },
    ],
    sizes: "(max-width: 768px) 100vw, 640px",
    width: 640,
    height: 480,
  },
  { src: "https://cdn.example.test/frame-2.webp", width: 640, height: 480 },
];

describe("F1.2 — lazy viewer server shells and URL safety", () => {
  it("renders only the current SPIN_360 frame, multi-format AVIF/WebP sources, and ARIA controls", () => {
    const html = renderToStaticMarkup(
      React.createElement(Spin360, { frames, alt: "Producto giratorio" }),
    );
    assert.equal((html.match(/<img/g) ?? []).length, 1);
    assert.ok(html.includes('type="image/avif"'));
    assert.ok(html.includes('type="image/webp"'));
    assert.ok(html.includes("frame-1.webp"));
    assert.equal(html.includes('src="https://cdn.example.test/frame-2.webp"'), false);
    assert.ok(html.includes('role="slider"'));
    assert.ok(html.includes("Vista anterior"));
    assert.ok(html.includes("Vista siguiente"));
    // Live status region must sit outside role="slider" so ARIA presentational children rules do not mute it
    const sliderClose = html.indexOf("</div>");
    const statusPos = html.indexOf('role="status"');
    assert.ok(statusPos > sliderClose);
  });

  it("shows an accessible error instead of invalid frame counts or unsafe URLs", () => {
    for (const invalidFrames of [
      [frames[0]],
      [
        { src: "javascript:alert(1)", width: 640, height: 480 },
        { src: "https://cdn.example.test/frame-2.webp", width: 640, height: 480 },
      ],
      [
        { src: "http://insecure.example.test/frame-1.webp", width: 640, height: 480 },
        { src: "https://cdn.example.test/frame-2.webp", width: 640, height: 480 },
      ],
    ]) {
      const html = renderToStaticMarkup(
        React.createElement(Spin360, { frames: invalidFrames, alt: "Producto" }),
      );
      assert.ok(html.includes('role="alert"'));
      assert.ok(html.includes("no está disponible"));
      assert.equal(html.includes("javascript:"), false);
    }
  });

  it("does not import model-viewer or request GLB/USDZ before user interaction and blocks unsafe URLs", () => {
    const glb = "https://cdn.example.test/model.glb";
    const html = renderToStaticMarkup(
      React.createElement(Model3d, {
        glbSrc: glb,
        usdzSrc: "https://cdn.example.test/model.usdz",
        posterSrc: "https://cdn.example.test/poster.avif",
        alt: "Modelo del producto",
      }),
    );
    assert.ok(html.includes("Explorar en 3D / AR"));
    assert.ok(html.includes("poster.avif"));
    assert.equal(html.includes("<model-viewer"), false);
    assert.equal(html.includes(glb), false);
    assert.ok(html.includes("realidad aumentada"));

    const unsafeHtml = renderToStaticMarkup(
      React.createElement(Model3d, {
        glbSrc: "javascript:alert(1)",
        alt: "Modelo inseguro",
      }),
    );
    assert.ok(unsafeHtml.includes('role="alert"'));
    assert.equal(unsafeHtml.includes("javascript:"), false);
  });

  it("maps derivative descriptors into sorted SpinFrame sources via buildSpinFrames", () => {
    const mapped = buildSpinFrames(
      [
        {
          frame: 1,
          derivatives: [
            { format: "webp", width: 640, height: 480, key: "p/f2/640.webp" },
            { format: "avif", width: 640, height: 480, key: "p/f2/640.avif" },
          ],
        },
        {
          frame: 0,
          derivatives: [
            { format: "webp", width: 640, height: 480, key: "p/f1/640.webp" },
            { format: "avif", width: 320, height: 240, key: "p/f1/320.avif" },
          ],
        },
      ],
      { baseUrl: "https://media.example.test" },
    );
    assert.equal(mapped.length, 2);
    assert.equal(mapped[0].src, "https://media.example.test/p/f1/640.webp");
    assert.equal(mapped[1].src, "https://media.example.test/p/f2/640.webp");
  });
});
