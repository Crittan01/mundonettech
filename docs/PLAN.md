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
| **Compuerta Calle** | **Maduración Operativa (`M1`–`M4`)** | `M1` Rodaje `LOCAL` · `M2` Identidad + `STG` · `M3` Go-Live `mundonettech.co` · `M4` Meta/ML vivos. | `[ ]` |
| **Hito 3 (Diferido)** | **Fase 7 — WhatsApp + Agente IA** | **Congelada hasta `M1`–`M4`:** WhatsApp Cloud API + Gemini TS sobre `packages/core` + Inbox *takeover*. | `[ ]` |

---

## 2. Fase Activa — Maduración Operativa (`M1`–`M4`, requisito previo a `Fase 7`)

- `[x]` ✅ **Fases 0–6 en código/CI (`F0.1`–`F6.4`, `ADR-019`..`045`):** MFA `aal2`/RLS (`131` tablas/`2.272` casos)/Bóveda, Catálogo/Media R2/WAC, CMS/Legal/SEO, Carrito/Checkout/Pagos/Logística/DIAN, Operación/`3.500 UVT`/RMA/PQR/Reseñas + OWASP/E2E+axe/Lighthouse/k6/`release:verify`, CRM/B2B, Lealtad/Lifecycle/RFM + Salud/Backups GPG/DR/Ayuda v2 y ML `MCO` + Meta Catalog/CAPI.
- `[ ]` **`M1` — Rodaje Humano `LOCAL` (`Hito 1` puro):** recorrido manual en `:4010` (móvil/escritorio) de catálogo/medios/stock/seriales reales, compra, pagos, despacho, posventa y finanzas; pulir toda fricción UX/operativa antes de exponer ambientes externos.
- `[ ]` **`M2` — Identidad y `STG` Core (`Hito 1`):** logo `.svg`/paleta, NIT/razón social/dirección/buzones y revisión jurídica (`config/`, `COMPLIANCE.md`); Supabase `STG` + R2 con **Resend, Wompi y Aveonline** verificados + `pnpm release:verify` (`STG`).
- `[ ]` **`M3` — Go-Live Core Web (`mundonettech.co` — `Hito 1`):** promoción humana `develop → production`, `release:verify` (`PRD`), primeros pedidos/despachos/reembolsos reales sin incidentes y backups GPG R2 + DR drill (`≤ 36 h`) vivos.
- `[ ]` **`M4` — Canales Externos (`Hito 2` sobre operación madura):** 1) Merchant + **Meta Catalog/CAPI** con dominio/portafolio verificados en Meta Business (`RELEASE_META_VERIFIED`); 2) **Mercado Libre `MCO`** (`RELEASE_MERCADO_LIBRE_VERIFIED`).
- `[ ]` **🔒 `Fase 7` (`F7.1`–`F7.3`, bloqueada hasta cerrar `M1`–`M4`):** `F7.1` Cloud API + HMAC + ventana 24 h + Ley 1581 · `F7.2` Agente Gemini TS sobre `packages/core` (`/pagar/[token]`, 0-PII) · `F7.3` Inbox `/admin/whatsapp` con *takeover* y MFA.

---

## 3. Handoff para la siguiente sesión

- **Gobierno vigente:** **congelado `feat/f7-*`** hasta certificar en calle `M1`–`M4` (catálogo curado, Core vivo y Meta Business verificado).
- **Siguiente turno — Rodaje Humano `M1`:** levantar `:4010`, recorrer punta a punta comprador y `/admin` sobre el *Core* (`Hito 1`), corregir asperezas reales en ramas `fix/m1-*` con gates en verde y alistar checklist `M2` (`STG`).
