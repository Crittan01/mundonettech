"use client";

import ImageModule from "next/image.js";

const Image = (ImageModule as unknown as { default: typeof ImageModule }).default;
import { useRef, useState, type PointerEvent } from "react";

export interface SpinFrame {
  src: string;
  srcSet?: string;
  width: number;
  height: number;
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
  const [current, setCurrent] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const startX = useRef<number | null>(null);
  const lastStep = useRef(0);
  if (frames.length < 2) return <p role="alert">La secuencia 360° no está disponible.</p>;
  const frame = frames[current]!;

  function move(direction: number): void {
    setCurrent((index) => (index + direction + frames.length) % frames.length);
    setLoaded(false);
    setError(false);
  }
  function prefetch(direction: number): void {
    const next = frames[(current + direction + frames.length) % frames.length]!;
    const image = new window.Image();
    image.src = next.src;
    if (next.srcSet) image.srcset = next.srcSet;
  }
  function pointerDown(event: PointerEvent<HTMLDivElement>): void {
    startX.current = event.clientX;
    lastStep.current = 0;
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (startX.current === null) return;
    const step = Math.trunc((event.clientX - startX.current) / 24);
    const difference = step - lastStep.current;
    if (difference !== 0) {
      move(-Math.sign(difference));
      lastStep.current = step;
    }
  }

  return (
    <figure className={className}>
      <div
        role="slider"
        tabIndex={0}
        aria-label={alt}
        aria-valuemin={1}
        aria-valuemax={frames.length}
        aria-valuenow={current + 1}
        aria-valuetext={`Vista ${current + 1} de ${frames.length}`}
        className="relative cursor-grab touch-pan-y overflow-hidden rounded-xl border border-border bg-secondary focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={() => {
          startX.current = null;
          prefetch(1);
        }}
        onPointerCancel={() => {
          startX.current = null;
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            move(-1);
            prefetch(-1);
          }
          if (event.key === "ArrowRight") {
            event.preventDefault();
            move(1);
            prefetch(1);
          }
        }}
      >
        <picture>
          {frame.srcSet ? <source srcSet={frame.srcSet} /> : null}
          <Image
            key={frame.src}
            src={frame.src}
            alt={`${alt}, vista ${current + 1}`}
            width={frame.width}
            height={frame.height}
            unoptimized
            loading="lazy"
            draggable={false}
            onLoad={() => setLoaded(true)}
            onError={() => setError(true)}
            className="h-auto w-full select-none"
          />
        </picture>
        {!loaded && !error ? (
          <p
            className="absolute inset-x-0 bottom-0 bg-background/80 p-2 text-center text-sm"
            role="status"
          >
            Cargando vista…
          </p>
        ) : null}
        {error ? (
          <p
            className="absolute inset-0 flex items-center justify-center bg-background p-4 text-center"
            role="alert"
          >
            No pudimos cargar esta vista.
          </p>
        ) : null}
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => {
            move(-1);
            prefetch(-1);
          }}
          className="rounded-md border border-border px-3 py-2"
          aria-label="Vista anterior"
        >
          Anterior
        </button>
        <figcaption className="text-center text-sm text-muted-foreground">
          Arrastra o usa las flechas · {current + 1}/{frames.length}
        </figcaption>
        <button
          type="button"
          onClick={() => {
            move(1);
            prefetch(1);
          }}
          className="rounded-md border border-border px-3 py-2"
          aria-label="Vista siguiente"
        >
          Siguiente
        </button>
      </div>
    </figure>
  );
}
