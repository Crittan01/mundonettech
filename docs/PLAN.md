# Plan Maestro Vivo — MundoNetTech (`mundonettech.co`)

> **Workboard vivo de Nivel 0 (≤ 160 lín.).** Estados: `[ ]` pendiente · `[R]` implementado (en auditoría) · `[x]` certificado. Expande solo la fase activa; compacta fases cerradas a 1 línea `✅`. Detalle en [`ARCHITECTURE.md`](ARCHITECTURE.md).

## 1. Mapa Ejecutivo de Hitos y Fases

| Hito | Fase | Alcance resumido | Estado |
| --- | --- | --- | :---: |
| **Hito 1 — Go-Live** | **Fase 0 — Fundación, Seguridad y Shell Admin** | Gobernanza, Next 16, PG 17 `BigInt` + RLS + Bóveda + Outbox, Auth + Admin **MFA `aal2`** + RBAC 8 roles + PII mask y CI/Gates (`F0.1`–`F0.5`). | `[x]` |
| **Hito 1** | **Fase 1 — Catálogo Tech, Media 360°/3D e Inventario WAC** | Catálogo/Facetas/GS1/Bundles (`F1.1`), `packages/media` R2/360°/3D (`F1.2`), Multi-bodega WAC/CSV (`F1.3`), `CatalogService` `'use cache'`/PDP/Admin (`F1.4`). | `[x]` |
| **Hito 1** | **Fase 2 — CMS v3, SEO y Legal CO** | CMS Zod + `StoreSettings` + R2 (`F2.1`), `/pagina/[slug]` PPR + Live Edit + SERP (`F2.2`), `packages/legal-co` + `UrlRedirect` + JSON-LD/Sitemap/Merchant XML (`F2.3`). | `[x]` |
| **Hito 1** | **Fase 3 — Carrito, Checkout, IVA Dual, Pagos y Logística** | `F3.1` Carrito/Mayorista/Bundles/Cupones/`/pagar/[token]` · `F3.2` Checkout DANE + IVA Dual/UVT + `OrderReceipt` + Outbox · `F3.3` Bóveda + Pagos · `F3.4` Aveonline/Flex + Resend/Svix + DIAN. | `[x]` |
| **Hito 1** | **Fase 4A — Operación, RMA/Seriales y Lanzamiento** | `F4A.1` `/admin/{hoy,dashboard,pedidos,finanzas}` (`OrderRefund`) + `3.500 UVT` · `F4A.2` `/mi-cuenta/*` + `/pedido/[token]` 2FA + RMA (`SerializedUnit`) + PQR SLA + Reseñas · `F4A.3` OWASP + E2E + axe + Lighthouse ≥ 95 + k6 + **Go-Live**. | `[ ]` |
| **Hito 2 — Escala** | **Fase 4B — CRM 360 y Canal B2B** | `F4B.1` `Contact` 360° + duplicados + tareas + retención Hábeas Data · `F4B.2` `PriceList` B2B + `/empresas` → `/propuesta/[token]` `BigInt` → `Order` + Copiloto 0-PII. | `[ ]` |
| **Hito 2** | **Fase 5 — Lealtad, Lifecycle y Observabilidad** | `F5.1` Puntos (reversa `EARN`) + Referidos + Abandonados · `F5.2` Lifecycle + Segmentos Ley 1581 + RFM/LTV · `F5.3` Salud + Alertas + Backups GPG R2 streaming + DR drill + Ayuda v2. | `[ ]` |
| **Hito 2** | **Fase 6 — Omnicanal ML `MCO` + Meta CAPI** | `F6.1` OAuth PKCE · `F6.2` User Products + `x-version` + Full + precios (zona muerta \$60k) · `F6.3` `ChannelPack`/`ChannelOrder` + `ME2`/Flex + conciliación · `F6.4` Meta Catalog + CAPI. | `[ ]` |
| **Hito 3 (Opc.)** | **Fase 7 — WhatsApp + Agente IA** | WhatsApp Cloud API + Agente Gemini TS sobre `packages/core` + Inbox humano con *takeover*. | `[ ]` |

---

## 2. Fase Activa — Fase 4A: Operación, RMA/Seriales y Lanzamiento

- `[x]` ✅ **Fases 0–3 (`F0.1`–`F3.4`):** Fundación MFA `aal2`/RLS/Bóveda (`ADR-019`..`022`), Catálogo/Media R2/WAC (`ADR-023`..`026`), CMS v3/Legal CO/SEO (`ADR-027`..`029`) y Carrito/Checkout/Pagos/Aveonline/Flex/Resend/DIAN (`ADR-030`..`033`).
- `[x]` **`F4A.1` — Operación `/admin/{hoy,dashboard,pedidos,finanzas}` y Monitor `3.500 UVT`:** bandeja `/admin/hoy` (pendientes por RBAC + `Notification`/`NotificationRead`), `/admin/dashboard` KPIs `BigInt` (`DailyFunnelMetric` 0-PII), `/admin/pedidos` (vista 360°, asignación `SerializedUnit`/IMEI y `OrderRefund` MFA) y `/admin/finanzas` (neto descontando `OrderRefund` 100 %, WAC/margen entero, CSV seguro y `FiscalWatchSnapshot` `3.500 UVT`, `ADR-034`).
- `[ ]` **`F4A.2` — `/mi-cuenta/*`, `/pedido/[token]` 2FA, RMA (`SerializedUnit`), PQR SLA y Reseñas:** autoservicio cliente (perfil, direcciones DANE, pedidos, anonimización Ley 1581), posventa invitado 2FA, `ReturnRequest`/`ReturnRequestItem` (retracto parcial `REFUND` ≤ 5 días hábiles CO + `EXCHANGE`), `WarrantyClaim` (`SerializedUnit` + `OrderRefund`), `SupportTicket`/`SupportTicketMessage` SLA CO y `Review` verificada (`OrderItem` entregado) + moderación MFA.
- `[ ]` **`F4A.3` — Endurecimiento OWASP, E2E/axe, Lighthouse ≥ 95, Carga k6 y Go-Live:** auditoría OWASP/CSP/RLS/RBAC/step-up, suite E2E + axe 0 violaciones WCAG 2.1 AA, presupuesto real **Lighthouse ≥ 95** (móvil/desktop standalone), carga concurrente k6 (stock/cupones/checkout/pagos sin sobrecupo ni deadlocks), checklist `STG → PRD` y **Go-Live**.

---

## 3. Handoff para la siguiente sesión

- **Siguiente turno — Implementador (`F4A.2`):** partir de `develop` limpio y crear rama `feat/f4a-2-account-guest-rma-pqr-reviews`. Construir `/mi-cuenta/*` (perfil, direcciones DANE, pedidos y anonimización Ley 1581), `/pedido/[token]` 2FA invitado, RMA (`ReturnRequest`/`ReturnRequestItem` retracto parcial ≤ 5 días hábiles CO + `EXCHANGE` y `WarrantyClaim` sobre `SerializedUnit` + `OrderRefund`), `SupportTicket`/`SupportTicketMessage` SLA CO y `Review` verificada (`OrderItem` entregado) + moderación MFA; pasar gates, marcar `[R]` y relevar al **Auditor**.
