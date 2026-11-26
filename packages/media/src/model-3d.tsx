"use client";

import ImageModule from "next/image.js";
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type DetailedHTMLProps,
  type HTMLAttributes,
  type KeyboardEvent,
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
  "interaction-prompt"?: "auto" | "none";
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
  const sourceKey = `${glbSrc}\0${usdzSrc ?? ""}`;
  const [syncedSourceKey, setSyncedSourceKey] = useState(sourceKey);
  const [status, setStatus] = useState<ViewerStatus>("idle");
  const [elementReady, setElementReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const viewer = useRef<HTMLElement>(null);
  const startButtonRef = useRef<HTMLButtonElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const pendingFocusRef = useRef<"viewer" | "idle" | null>(null);

  if (syncedSourceKey !== sourceKey) {
    setSyncedSourceKey(sourceKey);
    setStatus("idle");
    setElementReady(false);
    setAttempt(0);
    setFailedAttempts(0);
  }

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
    const element = viewer.current as (HTMLElement & { loaded?: boolean }) | null;
    if (!element || !elementReady || status !== "loading") return;
    if (element.loaded === true) {
      setStatus("ready");
      return;
    }
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
  }, [elementReady, status, attempt, modelSrc]);

  useEffect(() => {
    if (status === "idle" && pendingFocusRef.current === "idle") {
      pendingFocusRef.current = null;
      startButtonRef.current?.focus();
    } else if (status === "loading" && pendingFocusRef.current === "viewer") {
      backButtonRef.current?.focus();
    } else if (status === "ready" && pendingFocusRef.current === "viewer") {
      pendingFocusRef.current = null;
      viewer.current?.focus();
    } else if (status === "error" && pendingFocusRef.current === "viewer") {
      pendingFocusRef.current = null;
      retryButtonRef.current?.focus();
    }
  }, [status]);

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
    pendingFocusRef.current = "viewer";
    if (status === "error") setFailedAttempts((value) => value + 1);
    setElementReady(false);
    setAttempt((value) => value + 1);
    setStatus("loading");
  }

  function resetToPoster(): void {
    pendingFocusRef.current = "idle";
    setStatus("idle");
  }

  function handleViewerKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      resetToPoster();
    }
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
            ref={startButtonRef}
            type="button"
            onClick={start}
            className="min-h-11 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
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
              interaction-prompt="none"
              shadow-intensity="1"
              loading="eager"
              tabIndex={0}
              aria-label={alt}
              onKeyDown={handleViewerKeyDown}
              className="block min-h-80 w-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            />
          ) : posterSrc ? (
            <div className="flex min-h-80 items-center justify-center p-6">
              <Image
                src={posterSrc}
                alt={alt}
                width={posterWidth}
                height={posterHeight}
                unoptimized
                loading="eager"
                decoding="async"
                className="mx-auto max-h-72 w-auto opacity-80"
              />
            </div>
          ) : (
            <div className="min-h-80" />
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-background px-4 py-2">
            {status === "loading" ? (
              <p className="text-sm text-muted-foreground" role="status">
                Cargando modelo 3D…
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Arrastra o usa las flechas del teclado para girar; pulsa Escape para salir.
              </p>
            )}
            <button
              ref={backButtonRef}
              type="button"
              onClick={resetToPoster}
              className="min-h-11 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
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
              ref={retryButtonRef}
              type="button"
              onClick={start}
              className="min-h-11 rounded-md border border-input bg-background px-4 py-2 text-sm text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
            >
              Reintentar
            </button>
            <button
              type="button"
              onClick={resetToPoster}
              className="min-h-11 rounded-md border border-input bg-background px-4 py-2 text-sm text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
            >
              Volver a vista fija
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
