# Plan Maestro Vivo — MundoNetTech (`mundonettech.co`)

> **Workboard vivo de Nivel 0 (≤ 160 lín.).** Estados: `[ ]` pendiente · `[R]` implementado (en auditoría) · `[x]` certificado. Expande solo la fase activa; compacta fases cerradas a 1 línea `✅`. Detalle en [`ARCHITECTURE.md`](ARCHITECTURE.md).

## 1. Mapa Ejecutivo de Hitos y Fases

| Hito | Fase | Alcance resumido | Estado |
| --- | --- | --- | :---: |
| **Hito 1 — Go-Live** | **Fase 0 — Fundación, Seguridad y Shell Admin** | Gobernanza, Next 16, PG 17 `BigInt` + RLS + Bóveda + Outbox, Auth + Admin **MFA `aal2`** + RBAC 8 roles + PII mask y CI/Gates (`F0.1`–`F0.5`). | `[x]` |
| **Hito 1** | **Fase 1 — Catálogo Tech, Media 360°/3D e Inventario WAC** | Catálogo/Facetas/GS1/Bundles (`F1.1`), `packages/media` R2/360°/3D (`F1.2`), Multi-bodega WAC/CSV (`F1.3`), `CatalogService` `'use cache'`/PDP/Admin (`F1.4`). | `[x]` |
| **Hito 1** | **Fase 2 — CMS v3, SEO y Legal CO** | CMS Zod + `StoreSettings` + R2 (`F2.1`), `/pagina/[slug]` PPR + Live Edit + SERP (`F2.2`), `packages/legal-co` + `UrlRedirect` + JSON-LD/Sitemap/Merchant XML (`F2.3`). | `[x]` |
| **Hito 1** | **Fase 3 — Carrito, Checkout, IVA Dual, Pagos y Logística** | `F3.1` Carrito/Mayorista/Bundles/Cupones/`/pagar/[token]` · `F3.2` Checkout DANE + IVA Dual/UVT + `OrderReceipt` + Outbox · `F3.3` Bóveda + Pagos · `F3.4` Aveonline/Flex + Resend/Svix + DIAN. | `[x]` |
| **Hito 1** | **Fase 4A — Operación, RMA/Seriales y Lanzamiento** | `F4A.1` `/admin/{hoy,dashboard,pedidos,finanzas}` (`OrderRefund`) + `3.500 UVT` · `F4A.2` `/mi-cuenta/*` + `/pedido/[token]` 2FA + RMA (`SerializedUnit`) + PQR SLA + Reseñas · `F4A.3` OWASP + E2E + axe + Lighthouse ≥ 95 + k6 + `release:verify` (**Go-Live** real sujeto a externos). | `[x]` |
| **Hito 2 — Escala** | **Fase 4B — CRM 360 y Canal B2B** | `F4B.1` `Contact` 360° + duplicados + tareas + retención Hábeas Data · `F4B.2` `PriceList` B2B + `/empresas` → `/propuesta/[token]` `BigInt` → `Order` + Copiloto 0-PII. | `[x]` |
| **Hito 2** | **Fase 5 — Lealtad, Lifecycle y Observabilidad** | `F5.1` Puntos (reversa `EARN`) + Referidos + Abandonados · `F5.2` Lifecycle + Segmentos Ley 1581 + RFM/LTV · `F5.3` Salud + Alertas + Backups GPG R2 streaming + DR drill + Ayuda v2. | `[x]` |
| **Hito 2** | **Fase 6 — Omnicanal ML `MCO` + Meta CAPI** | `F6.1` OAuth PKCE · `F6.2` User Products + `x-version` + Full + precios (zona muerta \$60k) · `F6.3` `ChannelPack`/`ChannelOrder` + `ME2`/Flex + conciliación · `F6.4` Meta Catalog + CAPI. | `[x]` |
| **Hito 3 (Opc.)** | **Fase 7 — WhatsApp + Agente IA** | WhatsApp Cloud API + Agente Gemini TS sobre `packages/core` + Inbox humano con *takeover*. | `[ ]` |

---

## 2. Fase Activa — Fase 7: WhatsApp + Agente IA (`Hito 3` Opcional)

- `[x]` ✅ **Fases 0–6 (`F0.1`–`F6.4`):** MFA `aal2`/RLS/Bóveda (`ADR-019`..`022`), Catálogo/Media R2/WAC (`ADR-023`..`026`), CMS v3/Legal CO/SEO (`ADR-027`..`029`), Carrito/Checkout/Pagos/Logística/DIAN (`ADR-030`..`033`), Operación/`3.500 UVT`/RMA/PQR/Reseñas + OWASP/E2E+axe/Lighthouse `96–100`/k6/`release:verify` (`ADR-034`..`036`), CRM 360° + B2B/Copiloto 0-PII (`ADR-037`..`038`), Lealtad/Lifecycle/RFM + Salud/Backups GPG R2/DR/Ayuda v2 (`ADR-039`..`041`) y Omnicanal ML `MCO` + Meta Catalog/CAPI (`ADR-042`..`045`; 131 tablas/2.272 casos; Go-Live sujeto a externos).
- `[ ]` **`F7.1` — WhatsApp Cloud API, Webhooks Firmados y Conversaciones:** credenciales en bóveda `AES-256-GCM` aisladas por ambiente, verificación HMAC-SHA256 + anti-replay, ventana de atención 24 h / plantillas aprobadas, consentimiento Ley 1581 / baja efectiva, outbox 0-PII y persistencia con RLS forzada.
- `[ ]` **`F7.2` — Agente IA Gemini TS sobre `packages/core`:** herramientas deterministas de catálogo, compatibilidad, stock y estado de pedido verificados sobre servicios de dominio reales (cero invención de precios, existencias o políticas), minimización estricta de PII y trazabilidad de ejecuciones.
- `[ ]` **`F7.3` — Inbox Humano `/admin/whatsapp` con *Takeover*:** cola multi-operador con transferencia automática/manual IA ↔ humano (*takeover* y devolución), máscara PII server-side, RBAC + step-up MFA, SLA operativo en `/admin/hoy` y auditoría completa.

---

## 3. Handoff para la siguiente sesión

- **Siguiente turno — Implementador (`F7.1`):** partir de `develop` limpio, crear `feat/f7-1-whatsapp-cloud-api`, construir la integración WhatsApp Cloud API (bóveda por ambiente, webhooks HMAC-SHA256 + outbox 0-PII, ventana 24 h/plantillas, Ley 1581 y modelos con RLS forzada), registrar `ADR-046`, pasar `make check && pnpm test && pnpm build`, marcar `[R]` y relevar al **Auditor** (`Hito 1` y `Hito 2` ya certificados; Go-Live real sujeto a externos).
