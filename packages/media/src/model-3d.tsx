"use client";

import ImageModule from "next/image.js";
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type DetailedHTMLProps,
  type HTMLAttributes,
} from "react";

import { isSafeMediaUrl } from "./responsive-sources.js";

const Image = (
  typeof ImageModule === "object" && ImageModule !== null && "default" in ImageModule
    ? (ImageModule as { default: unknown }).default
    : ImageModule
) as typeof import("next/image").default;

type ViewerStatus = "idle" | "loading" | "ready" | "error";
type ModelViewerProps = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
  src: string;
  "ios-src"?: string;
  poster?: string;
  ar?: boolean;
  "ar-modes"?: string;
  "camera-controls"?: boolean;
  "shadow-intensity"?: string;
  loading?: "eager" | "lazy";
};
const ModelViewer = "model-viewer" as unknown as ComponentType<ModelViewerProps>;

const loadTimeoutMs = 20_000;

export function Model3d({
  glbSrc,
  usdzSrc,
  posterSrc,
  posterWidth = 800,
  posterHeight = 600,
  alt,
  className = "",
}: {
  glbSrc: string;
  usdzSrc?: string;
  posterSrc?: string;
  posterWidth?: number;
  posterHeight?: number;
  alt: string;
  className?: string;
}) {
  const [status, setStatus] = useState<ViewerStatus>("idle");
  const [elementReady, setElementReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const viewer = useRef<HTMLElement>(null);

  const safeSources =
    isSafeMediaUrl(glbSrc) &&
    (usdzSrc === undefined || isSafeMediaUrl(usdzSrc)) &&
    (posterSrc === undefined || isSafeMediaUrl(posterSrc));
  const modelSrc =
    failedAttempts === 0 ? glbSrc : `${glbSrc.replace(/#.*$/, "")}#model-retry=${failedAttempts}`;

  useEffect(() => {
    if (status !== "loading" || !safeSources) return;
    let active = true;
    void import("@google/model-viewer")
      .then(() => {
        if (active) setElementReady(true);
      })
      .catch(() => {
        if (active) setStatus("error");
      });
    return () => {
      active = false;
    };
  }, [status, attempt, safeSources]);

  useEffect(() => {
    const element = viewer.current;
    if (!element || !elementReady || status !== "loading") return;
    const loaded = () => setStatus("ready");
    const failed = () => setStatus("error");
    element.addEventListener("load", loaded);
    element.addEventListener("error", failed);
    const timer = window.setTimeout(() => {
      setStatus((current) => (current === "loading" ? "error" : current));
    }, loadTimeoutMs);
    return () => {
      window.clearTimeout(timer);
      element.removeEventListener("load", loaded);
      element.removeEventListener("error", failed);
    };
  }, [elementReady, status, attempt]);

  if (!safeSources) {
    return (
      <section className={className} aria-label={alt}>
        <div
          className="rounded-xl border border-border bg-background p-5 text-center text-foreground"
          role="alert"
        >
          El modelo 3D no está disponible.
        </div>
      </section>
    );
  }

  function start(): void {
    if (status === "error") setFailedAttempts((value) => value + 1);
    setElementReady(false);
    setAttempt((value) => value + 1);
    setStatus("loading");
  }

  function resetToPoster(): void {
    setStatus("idle");
  }

  return (
    <section className={className} aria-label={alt}>
      {status === "idle" ? (
        <div className="space-y-4 rounded-xl border border-border bg-secondary p-6 text-center">
          {posterSrc ? (
            <Image
              src={posterSrc}
              alt={alt}
              width={posterWidth}
              height={posterHeight}
              unoptimized
              loading="lazy"
              decoding="async"
              className="mx-auto max-h-80 w-auto"
            />
          ) : null}
          <p className="text-sm text-muted-foreground">
            Carga el modelo solo cuando quieras explorarlo. Incluye controles de cámara
            {usdzSrc ? " y realidad aumentada" : ""}.
          </p>
          <button
            type="button"
            onClick={start}
            className="min-h-11 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            Explorar en 3D{usdzSrc ? " / AR" : ""}
          </button>
        </div>
      ) : null}
      {status === "loading" || status === "ready" ? (
        <div className="min-h-80 overflow-hidden rounded-xl border border-border bg-secondary">
          {elementReady ? (
            <ModelViewer
              key={attempt}
              ref={viewer}
              src={modelSrc}
              {...(usdzSrc ? { "ios-src": usdzSrc } : {})}
              {...(posterSrc ? { poster: posterSrc } : {})}
              ar
              ar-modes={usdzSrc ? "webxr scene-viewer quick-look" : "webxr scene-viewer"}
              camera-controls
              shadow-intensity="1"
              loading="eager"
              aria-label={alt}
              style={{ width: "100%", minHeight: "320px" }}
            />
          ) : null}
          <div className="flex items-center justify-between gap-3 border-t border-border bg-background px-4 py-2">
            {status === "loading" ? (
              <p className="text-sm text-muted-foreground" role="status">
                Cargando modelo 3D…
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Arrastra para girar o pellizca para acercar.
              </p>
            )}
            <button
              type="button"
              onClick={resetToPoster}
              className="min-h-11 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Volver a vista fija
            </button>
          </div>
        </div>
      ) : null}
      {status === "error" ? (
        <div
          className="space-y-3 rounded-xl border border-border bg-background p-5 text-center text-foreground"
          role="alert"
        >
          <p>No pudimos cargar el modelo 3D. Revisa tu conexión.</p>
          <div className="flex flex-wrap justify-center gap-3">
            <button
              type="button"
              onClick={start}
              className="min-h-11 rounded-md border border-border bg-background px-4 py-2 text-sm text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Reintentar
            </button>
            <button
              type="button"
              onClick={resetToPoster}
              className="min-h-11 rounded-md border border-border bg-background px-4 py-2 text-sm text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Volver a vista fija
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
