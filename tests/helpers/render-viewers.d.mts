import type { SpinFrame } from "../../packages/media/dist/responsive-sources.js";

export function renderSpin360Markup(props: {
  frames: readonly SpinFrame[];
  alt: string;
  className?: string;
}): string;

export function renderModel3dMarkup(props: {
  glbSrc: string;
  usdzSrc?: string;
  posterSrc?: string;
  posterWidth?: number;
  posterHeight?: number;
  alt: string;
  className?: string;
}): string;
