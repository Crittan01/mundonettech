"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ActionState } from "@/lib/action-state";

interface TurnstileApi {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      "response-field": boolean;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
      "timeout-callback": () => void;
    },
  ) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export function TurnstileField({
  siteKey,
  action,
  nonce,
  state,
}: Readonly<{ siteKey: string; action: string; nonce: string; state: ActionState }>) {
  const container = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const widget = useRef<string | null>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const clearToken = () => {
    if (input.current) input.current.value = "";
  };

  const renderWidget = useCallback(() => {
    if (!container.current || !window.turnstile || widget.current) return;
    widget.current = window.turnstile.render(container.current, {
      sitekey: siteKey,
      action,
      "response-field": false,
      callback: (value) => {
        if (input.current) input.current.value = value;
        setError("");
      },
      "expired-callback": () => {
        clearToken();
        setError("El desafío expiró. Resuélvelo de nuevo.");
      },
      "error-callback": () => {
        clearToken();
        setError("No se pudo cargar el desafío. Recarga la página.");
      },
      "timeout-callback": () => {
        clearToken();
        setError("El desafío tardó demasiado. Inténtalo de nuevo.");
      },
    });
    setLoaded(true);
  }, [action, siteKey]);

  useEffect(() => {
    clearToken();
    if (widget.current && window.turnstile) window.turnstile.reset(widget.current);
  }, [state]);
  useEffect(() => {
    renderWidget();
    return () => {
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
      widget.current = null;
    };
  }, [renderWidget]);

  return (
    <div className="space-y-2" role="group" aria-label="Verificación de seguridad">
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        strategy="afterInteractive"
        nonce={nonce}
        onLoad={renderWidget}
        onError={() => setError("No se pudo cargar el desafío. Revisa tu conexión.")}
      />
      <div ref={container} className="min-h-16" aria-busy={!loaded} />
      <input ref={input} type="hidden" name="turnstileToken" defaultValue="" />
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
