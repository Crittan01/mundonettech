"use client";

import ImageModule from "next/image.js";

const Image = (ImageModule as unknown as { default: typeof ImageModule }).default;
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type DetailedHTMLProps,
  type HTMLAttributes,
} from "react";

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

export function Model3d({
  glbSrc,
  usdzSrc,
  posterSrc,
  alt,
  className = "",
}: {
  glbSrc: string;
  usdzSrc?: string;
  posterSrc?: string;
  alt: string;
  className?: string;
}) {
  const [status, setStatus] = useState<ViewerStatus>("idle");
  const [attempt, setAttempt] = useState(0);
  const viewer = useRef<HTMLElement>(null);

  useEffect(() => {
    if (status !== "loading") return;
    let active = true;
    void import("@google/model-viewer").catch(() => {
      if (active) setStatus("error");
    });
    return () => {
      active = false;
    };
  }, [status, attempt]);

  useEffect(() => {
    const element = viewer.current;
    if (!element || status !== "loading") return;
    const loaded = () => setStatus("ready");
    const failed = () => setStatus("error");
    element.addEventListener("load", loaded);
    element.addEventListener("error", failed);
    return () => {
      element.removeEventListener("load", loaded);
      element.removeEventListener("error", failed);
    };
  }, [status, attempt]);

  function start(): void {
    setAttempt((value) => value + 1);
    setStatus("loading");
  }

  return (
    <section className={className} aria-label={alt}>
      {status === "idle" ? (
        <div className="space-y-4 rounded-xl border border-border bg-secondary p-6 text-center">
          {posterSrc ? (
            <Image
              src={posterSrc}
              alt={alt}
              width={800}
              height={600}
              unoptimized
              loading="lazy"
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
            className="rounded-md bg-primary px-4 py-2 text-primary-foreground"
          >
            Explorar en 3D{usdzSrc ? " / AR" : ""}
          </button>
        </div>
      ) : null}
      {status === "loading" || status === "ready" ? (
        <div className="min-h-80 overflow-hidden rounded-xl border border-border bg-secondary">
          <ModelViewer
            key={attempt}
            ref={viewer}
            src={glbSrc}
            {...(usdzSrc ? { "ios-src": usdzSrc } : {})}
            {...(posterSrc ? { poster: posterSrc } : {})}
            ar={Boolean(usdzSrc)}
            ar-modes="webxr scene-viewer quick-look"
            camera-controls
            shadow-intensity="1"
            loading="eager"
            aria-label={alt}
            style={{ width: "100%", minHeight: "320px" }}
          />
          {status === "loading" ? (
            <p className="p-3 text-center text-sm" role="status">
              Cargando modelo 3D…
            </p>
          ) : null}
        </div>
      ) : null}
      {status === "error" ? (
        <div className="space-y-3 rounded-xl border border-border p-5 text-center" role="alert">
          <p>No pudimos cargar el modelo 3D. Revisa tu conexión.</p>
          <button
            type="button"
            onClick={start}
            className="rounded-md border border-border px-4 py-2"
          >
            Reintentar
          </button>
        </div>
      ) : null}
    </section>
  );
}
