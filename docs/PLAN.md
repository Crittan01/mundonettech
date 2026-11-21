# Plan Maestro Vivo — MundoNetTech (`mundonettech.co`)

> **Workboard vivo de Nivel 0 (≤ 160 lín.).** Estados: `[ ]` pendiente · `[R]` implementado (en auditoría) · `[x]` certificado. Expande solo la fase activa; compacta fases cerradas a 1 línea `✅`. Detalle en [`ARCHITECTURE.md`](ARCHITECTURE.md).

## 1. Mapa Ejecutivo de Hitos y Fases

| Hito | Fase | Alcance resumido | Estado |
| --- | --- | --- | :---: |
| **Hito 1 — Go-Live** | **Fase 0 — Fundación, Seguridad y Shell Admin** | Gobernanza (`F0.1`), Monorepo Next 16 (`F0.2`), PG 17 + Prisma `BigInt` + RLS + Bóveda + Outbox (`F0.3`), Auth + Login Admin + **MFA `aal2`** + RBAC 8 roles + PII mask (`F0.4`), CI/Gates (`F0.5`). | `[x]` |
| **Hito 1** | **Fase 1 — Catálogo Tech, Media 360°/3D e Inventario WAC** | `F1.1` Marcas, Categorías N-niveles, Colecciones, Atributos/Facetas (`ADR-008`), GTIN/EAN, Compatibilidad y Bundles · `F1.2` `packages/media` (R2 + AVIF/WebP + Spin 360° + 3D/AR lazy) · `F1.3` Multi-bodega (`safetyStock` efectivo + orden determinista de locks) + Proveedores/WAC + Importador CSV · `F1.4` `CatalogService` único (`'use cache'`), Comparador, PDP, Admin y seed. | `[x]` |
| **Hito 1** | **Fase 2 — CMS v3, SEO y Legal CO** | `F2.1` Bloques componibles Zod + `StoreSettings` separados + versionado/programación + Mediateca R2 · `F2.2` Live Edit en `<Suspense>` + SERP · `F2.3` `packages/legal-co` (8 docs, Ley 1480/2439 retracto + festivos CO, Ley 1581) + `UrlRedirect` + JSON-LD + Sitemap + Merchant XML (`Brand`/`GTIN`). | `[/]` |
| **Hito 1** | **Fase 3 — Carrito, Checkout, IVA Dual, Pagos y Logística** | `F3.1` `CartService` (revalidación precios, `WholesaleTier` multi-variante, Bundles, Cupones `BigInt`, Venta Asistida `/pagar/[token]`) · `F3.2` Checkout DANE/Click&Collect + IVA Dual/UVT + `OrderReceipt` (`ADR-010`) + `Shipment`/`OrderRefund` 1:N + `DomainOutbox` · `F3.3` Bóveda `/admin/integraciones` + `PaymentProvider` (`refund()`, Wompi, COD, Transferencia MFA, `StoreCredit`) · `F3.4` Aveonline *pick & pack* asíncrono + Claim Idempotente + multi-bulto + Flex local + Resend/Svix + puerto DIAN. | `[ ]` |
| **Hito 1** | **Fase 4A — Operación, RMA/Seriales y Lanzamiento** | `F4A.1` `/admin/{hoy,dashboard,pedidos,finanzas}` (cuadre total de `OrderRefund`) + Vigilancia `3.500 UVT` · `F4A.2` `/mi-cuenta/*` + Posventa 2FA `/pedido/[token]` + RMA (Retracto parcial, Cambios, Garantía con `SerializedUnit` Serial/IMEI) + PQR SLA + Reseñas con FK · `F4A.3` OWASP + Playwright E2E + `@axe-core` + Lighthouse ≥ 95 + k6 + **Go-Live `mundonettech.co`**. | `[ ]` |
| **Hito 2 — Escala** | **Fase 4B — CRM 360 y Canal B2B** | `F4B.1` `Contact` 360° + duplicados + tareas + retención Hábeas Data · `F4B.2` `PriceList` B2B + `/empresas` → Propuestas `BigInt` `/propuesta/[token]` → `Order` + Copiloto 0-PII. | `[ ]` |
| **Hito 2** | **Fase 5 — Lealtad, Lifecycle y Observabilidad** | `F5.1` Puntos (con reversa `EARN` en reembolso) + Referidos + Carritos abandonados · `F5.2` Lifecycle + Segmentos Ley 1581 + RFM/LTV · `F5.3` Observabilidad desacoplada + Alertas + Backups GPG streaming R2 + DR drill completo (`auth` + todos los buckets) + Ayuda v2. | `[ ]` |
| **Hito 2** | **Fase 6 — Omnicanal ML `MCO` + Meta CAPI** | `F6.1` OAuth PKCE serializado · `F6.2` Legacy/User Products + stock `x-version` + Full + precios `FORMULA`/`MANUAL` (zona muerta \$60k) · `F6.3` `ChannelPack`/`ChannelOrder` + `ME2`/Flex + posventa + conciliación · `F6.4` Meta Catalog + Pixel/CAPI. | `[ ]` |
| **Hito 3 (Opc.)** | **Fase 7 — WhatsApp + Agente IA** | WhatsApp Cloud API (Meta App propia) + Agente Gemini TS sobre `packages/core` + Inbox humano con *takeover*. | `[ ]` |

---

## 2. Fase Activa — Fase 2: CMS v3, SEO y Legal CO

- `[x]` ✅ **Fase 0 cerrada (`F0.1`–`F0.5`):** Gobernanza, Next.js 16 standalone (`'use cache'`), PG 17 + RLS *deny-by-default* + Bóveda `AES-256-GCM`, Auth OTP/HIBP/Turnstile, `/admin` MFA `aal2` + RBAC 8 roles + `pii-mask` y CI PG 17/Playwright/axe.
- `[x]` ✅ **Fase 1 cerrada (`F1.1`–`F1.4`):** Catálogo tech PG 17 (`29` modelos + `Order`, `BigInt`, GS1/EAN, `tsvector` GIN, `685` casos RLS), `@mundonettech/media` (R2 + `Spin360`/`Model3d` *lazy*), inventario WAC/seriales/CSV, `CatalogService` (`'use cache'`), PDP/PLP/Comparador, `/admin/catalogo` MFA y seed (`ADR-023`..`ADR-026`).
- `[x]` **`F2.1` — CMS v3 (`growth-cms.prisma`), `StoreSettings` y Mediateca R2 (`packages/cms`):** `StoreSettings` separada con RBAC (`ADR-016`), `CmsPage` + `CmsSectionBlock` (Zod + `{{tokens}}`) + `CmsBlockVersion` (versionado/programación), `CmsMedia` en R2 (`sharp-safe`), `/admin/{contenido,configuracion}` MFA y `770` casos RLS (`ADR-027`).
- `[R]` **`F2.2` — Renderizado `'use cache'`, Live Edit en `<Suspense>` y SERP:** `/pagina/[slug]` PPR con seis bloques, medios AVIF/WebP y grillas curadas; Live Edit `aal2` aislado, canonical/SERP/OpenGraph/Twitter Card e invalidación programada (`ADR-028`).
- `[ ]` **`F2.3` — Legal CO (`packages/legal-co`), Redirecciones, JSON-LD, Sitemap y Merchant XML (`COMPLIANCE.md`):** 8 docs legales desde `config/`, retracto 5 días hábiles + 18 festivos CO, Ley 1581, `UrlRedirect`, JSON-LD, `sitemap.xml` y Google Merchant XML (`Brand`/`GTIN`).

---

## 3. Handoff para la siguiente sesión

- **Siguiente turno — Auditor (`F2.2`):** auditar `git diff develop...HEAD` en `feat/f2-2-cms-cache-live-edit-serp` contra `ADR-015`/`ADR-028`, seguridad de previews, caché/PPR, tokens, grillas, SEO y completitud E2E; reejecutar `make check && pnpm test && pnpm build && pnpm test:e2e`, certificar `[x]` si no hay concesiones y seguir el protocolo de PR/merge.
