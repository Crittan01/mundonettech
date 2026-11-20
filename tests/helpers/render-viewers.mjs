import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Model3d, Spin360 } from "../../packages/media/dist/viewers.js";

export function renderSpin360Markup(props) {
  return renderToStaticMarkup(React.createElement(Spin360, props));
}

export function renderModel3dMarkup(props) {
  return renderToStaticMarkup(React.createElement(Model3d, props));
}
