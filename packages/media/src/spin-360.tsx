"use client";

import ImageModule from "next/image.js";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";

import { isSafeMediaUrl, isSafeSrcSet, type SpinFrame } from "./responsive-sources.js";

const Image = (
  typeof ImageModule === "object" && ImageModule !== null && "default" in ImageModule
    ? (ImageModule as { default: unknown }).default
    : ImageModule
) as typeof import("next/image").default;

function isValidFrame(frame: SpinFrame): boolean {
  if (
    !Number.isSafeInteger(frame.width) ||
    !Number.isSafeInteger(frame.height) ||
    frame.width < 1 ||
    frame.height < 1 ||
    !isSafeMediaUrl(frame.src)
  ) {
    return false;
  }
  if (frame.srcSet !== undefined && !isSafeSrcSet(frame.srcSet)) return false;
  if (frame.sources !== undefined) {
    for (const source of frame.sources) {
      if (!isSafeSrcSet(source.srcSet)) return false;
    }
  }
  return true;
}

export function Spin360({
  frames,
  alt,
  className = "",
}: {
  frames: readonly SpinFrame[];
  alt: string;
  className?: string;
}) {
  const framesKey = useMemo(() => frames.map((entry) => entry.src).join("\0"), [frames]);
  const [syncedFramesKey, setSyncedFramesKey] = useState(framesKey);
  const [current, setCurrent] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const startX = useRef<number | null>(null);
  const lastStep = useRef(0);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const prefetchedUrls = useRef<Set<string>>(new Set());

  if (syncedFramesKey !== framesKey) {
    setSyncedFramesKey(framesKey);
    setCurrent(0);
    setLoaded(false);
    setError(false);
    setRetryCount(0);
  }

  useEffect(() => {
    prefetchedUrls.current.clear();
  }, [framesKey]);

  const validFrames = useMemo(
    () => frames.length >= 2 && frames.length <= 120 && frames.every(isValidFrame),
    [frames],
  );

  const safeIndex = validFrames ? current % frames.length : 0;
  const frame = validFrames ? frames[safeIndex]! : null;

  useEffect(() => {
    const img = imageRef.current;
    if (!img || !frame) return;
    if (img.complete) {
      if (img.naturalWidth > 0) {
        setLoaded(true);
        setError(false);
      } else {
        setError(true);
        setLoaded(false);
      }
    }
  }, [frame, safeIndex, retryCount]);

  if (!validFrames || !frame) {
    return (
      <div
        className={`rounded-xl border border-border bg-background p-5 text-center text-foreground ${className}`.trim()}
        role="alert"
      >
        La secuencia 360° no está disponible.
      </div>
    );
  }

  function selectFrame(nextIndex: number): void {
    const normalized = ((nextIndex % frames.length) + frames.length) % frames.length;
    if (normalized === safeIndex) return;
    setCurrent(normalized);
    setLoaded(false);
    setError(false);
  }

  function move(direction: number): void {
    selectFrame(safeIndex + direction);
  }

  function retryFrame(): void {
    setError(false);
    setLoaded(false);
    setRetryCount((value) => value + 1);
  }

  function prefetchNeighbor(offset: number): void {
    if (typeof window === "undefined") return;
    const candidate =
      frames[(((safeIndex + offset) % frames.length) + frames.length) % frames.length];
    if (!candidate || prefetchedUrls.current.has(candidate.src)) return;
    prefetchedUrls.current.add(candidate.src);
    const preload = new window.Image();
    const webpSource = candidate.sources?.find((source) => source.type === "image/webp");
    const preferredSizes = webpSource?.sizes ?? candidate.sizes;
    if (preferredSizes) preload.sizes = preferredSizes;
    const preferredSrcSet = webpSource?.srcSet ?? candidate.srcSet;
    if (preferredSrcSet) preload.srcset = preferredSrcSet;
    preload.src = candidate.src;
  }

  function prefetchAdjacent(primaryDirection: number): void {
    prefetchNeighbor(primaryDirection);
    prefetchNeighbor(-primaryDirection);
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>): void {
    startX.current = event.clientX;
    lastStep.current = 0;
    if (typeof event.currentTarget.setPointerCapture === "function") {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic pointer events without active hardware pointerId remain functional.
      }
    }
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (startX.current === null) return;
    const step = Math.trunc((event.clientX - startX.current) / 24);
    const difference = step - lastStep.current;
    if (difference !== 0) {
      const direction = -Math.sign(difference);
      move(direction);
      prefetchNeighbor(direction);
      lastStep.current = step;
    }
  }

  const pageStep = Math.max(1, Math.round(frames.length / 8));
  const frameSrc =
    retryCount === 0 ? frame.src : `${frame.src.replace(/#.*$/, "")}#spin-retry=${retryCount}`;

  return (
    <figure className={className}>
      <div className="relative overflow-hidden rounded-xl border border-border bg-secondary">
        <div
          role="slider"
          tabIndex={0}
          aria-label={alt}
          aria-valuemin={1}
          aria-valuemax={frames.length}
          aria-valuenow={safeIndex + 1}
          aria-valuetext={`Vista ${safeIndex + 1} de ${frames.length}`}
          className="cursor-grab touch-pan-y focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing"
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={() => {
            startX.current = null;
            prefetchAdjacent(1);
          }}
          onPointerCancel={() => {
            startX.current = null;
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
              event.preventDefault();
              move(-1);
              prefetchAdjacent(-1);
            } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
              event.preventDefault();
              move(1);
              prefetchAdjacent(1);
            } else if (event.key === "PageDown") {
              event.preventDefault();
              move(-pageStep);
              prefetchAdjacent(-1);
            } else if (event.key === "PageUp") {
              event.preventDefault();
              move(pageStep);
              prefetchAdjacent(1);
            } else if (event.key === "Home") {
              event.preventDefault();
              selectFrame(0);
              prefetchAdjacent(1);
            } else if (event.key === "End") {
              event.preventDefault();
              selectFrame(frames.length - 1);
              prefetchAdjacent(-1);
            }
          }}
        >
          <picture key={retryCount}>
            {frame.sources?.map((source) => (
              <source
                key={`${source.type ?? "default"}-${source.srcSet}`}
                srcSet={source.srcSet}
                {...(source.type ? { type: source.type } : {})}
                {...((source.sizes ?? frame.sizes) ? { sizes: source.sizes ?? frame.sizes } : {})}
              />
            ))}
            {!frame.sources && frame.srcSet ? (
              <source srcSet={frame.srcSet} {...(frame.sizes ? { sizes: frame.sizes } : {})} />
            ) : null}
            <Image
              ref={imageRef}
              src={frameSrc}
              alt={`${alt}, vista ${safeIndex + 1}`}
              width={frame.width}
              height={frame.height}
              unoptimized
              loading="lazy"
              decoding="async"
              draggable={false}
              onLoad={() => {
                setLoaded(true);
                setError(false);
              }}
              onError={() => {
                setError(true);
                setLoaded(false);
              }}
              className="h-auto w-full select-none"
            />
          </picture>
        </div>
        {!loaded && !error ? (
          <p
            className="pointer-events-none absolute inset-x-0 bottom-0 bg-background/85 p-2 text-center text-sm text-foreground"
            role="status"
          >
            Cargando vista…
          </p>
        ) : null}
        {error ? (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-4 text-center text-foreground"
            role="alert"
          >
            <p>No pudimos cargar esta vista.</p>
            <button
              type="button"
              onClick={retryFrame}
              className="min-h-11 rounded-md border border-input bg-background px-4 py-2 text-sm text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
            >
              Reintentar
            </button>
          </div>
        ) : null}
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => {
            move(-1);
            prefetchAdjacent(-1);
          }}
          className="min-h-11 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
          aria-label="Vista anterior"
        >
          Anterior
        </button>
        <figcaption className="text-center text-sm text-muted-foreground">
          Arrastra o usa las flechas · {safeIndex + 1}/{frames.length}
        </figcaption>
        <button
          type="button"
          onClick={() => {
            move(1);
            prefetchAdjacent(1);
          }}
          className="min-h-11 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
          aria-label="Vista siguiente"
        >
          Siguiente
        </button>
      </div>
    </figure>
  );
}
