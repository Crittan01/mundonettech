import assert from "node:assert/strict";
import { describe, it } from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Model3d, Spin360 } from "../packages/media/dist/index.js";

const frames = [
  {
    src: "https://cdn.example.test/frame-1.avif",
    srcSet: "https://cdn.example.test/frame-1.avif 1x",
    width: 640,
    height: 480,
  },
  { src: "https://cdn.example.test/frame-2.avif", width: 640, height: 480 },
];

describe("F1.2 — lazy viewer server shells", () => {
  it("renders only the current SPIN_360 frame and accessible controls", () => {
    const html = renderToStaticMarkup(
      React.createElement(Spin360, { frames, alt: "Producto giratorio" }),
    );
    assert.equal((html.match(/<img/g) ?? []).length, 1);
    assert.ok(html.includes("frame-1.avif"));
    assert.equal(html.includes('src="https://cdn.example.test/frame-2.avif"'), false);
    assert.ok(html.includes('role="slider"'));
    assert.ok(html.includes("Vista anterior"));
    assert.ok(html.includes("Vista siguiente"));
  });

  it("shows an accessible error instead of an invalid one-frame animation", () => {
    const html = renderToStaticMarkup(
      React.createElement(Spin360, { frames: [frames[0]], alt: "Producto" }),
    );
    assert.ok(html.includes('role="alert"'));
    assert.ok(html.includes("no está disponible"));
  });

  it("does not import model-viewer or request GLB before user interaction", () => {
    const glb = "https://cdn.example.test/model.glb";
    const html = renderToStaticMarkup(
      React.createElement(Model3d, {
        glbSrc: glb,
        usdzSrc: "https://cdn.example.test/model.usdz",
        alt: "Modelo del producto",
      }),
    );
    assert.ok(html.includes("Explorar en 3D"));
    assert.equal(html.includes("<model-viewer"), false);
    assert.equal(html.includes(glb), false);
    assert.ok(html.includes("realidad aumentada"));
  });
});
