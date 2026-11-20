# Plan Maestro Vivo — MundoNetTech (`mundonettech.co`)

> **Workboard vivo de Nivel 0 (≤ 160 lín.).** Estados: `[ ]` pendiente · `[R]` implementado (en auditoría) · `[x]` certificado. Expande solo la fase activa; compacta fases cerradas a 1 línea `✅`. Detalle en [`ARCHITECTURE.md`](ARCHITECTURE.md).

## 1. Mapa Ejecutivo de Hitos y Fases

| Hito | Fase | Alcance resumido | Estado |
| --- | --- | --- | :---: |
| **Hito 1 — Go-Live** | **Fase 0 — Fundación, Seguridad y Shell Admin** | Gobernanza (`F0.1`), Monorepo Next 16 (`F0.2`), PG 17 + Prisma `BigInt` + RLS + Bóveda + Outbox (`F0.3`), Auth + Login Admin + **MFA `aal2`** + RBAC 8 roles + PII mask (`F0.4`), CI/Gates (`F0.5`). | `[x]` |
| **Hito 1** | **Fase 1 — Catálogo Tech, Media 360°/3D e Inventario WAC** | `F1.1` Marcas, Categorías N-niveles, Colecciones, Atributos/Facetas (`ADR-008`), GTIN/EAN, Compatibilidad y Bundles · `F1.2` `packages/media` (R2 + AVIF/WebP + Spin 360° + 3D/AR lazy) · `F1.3` Multi-bodega (`safetyStock` efectivo + orden determinista de locks) + Proveedores/WAC + Importador CSV · `F1.4` `CatalogService` único (`'use cache'`), Comparador, PDP, Admin y seed. | `[/]` |
| **Hito 1** | **Fase 2 — CMS v3, SEO y Legal CO** | `F2.1` Bloques componibles Zod + `StoreSettings` separados + versionado/programación + Mediateca R2 · `F2.2` Live Edit en `<Suspense>` + SERP · `F2.3` `packages/legal-co` (8 docs, Ley 1480/2439 retracto + festivos CO, Ley 1581) + `UrlRedirect` + JSON-LD + Sitemap + Merchant XML (`Brand`/`GTIN`). | `[ ]` |
| **Hito 1** | **Fase 3 — Carrito, Checkout, IVA Dual, Pagos y Logística** | `F3.1` `CartService` (revalidación precios, `WholesaleTier` multi-variante, Bundles, Cupones `BigInt`, Venta Asistida `/pagar/[token]`) · `F3.2` Checkout DANE/Click&Collect + IVA Dual/UVT + `OrderReceipt` (`ADR-010`) + `Shipment`/`OrderRefund` 1:N + `DomainOutbox` · `F3.3` Bóveda `/admin/integraciones` + `PaymentProvider` (`refund()`, Wompi, COD, Transferencia MFA, `StoreCredit`) · `F3.4` Aveonline *pick & pack* asíncrono + Claim Idempotente + multi-bulto + Flex local + Resend/Svix + puerto DIAN. | `[ ]` |
| **Hito 1** | **Fase 4A — Operación, RMA/Seriales y Lanzamiento** | `F4A.1` `/admin/{hoy,dashboard,pedidos,finanzas}` (cuadre total de `OrderRefund`) + Vigilancia `3.500 UVT` · `F4A.2` `/mi-cuenta/*` + Posventa 2FA `/pedido/[token]` + RMA (Retracto parcial, Cambios, Garantía con `SerializedUnit` Serial/IMEI) + PQR SLA + Reseñas con FK · `F4A.3` OWASP + Playwright E2E + `@axe-core` + Lighthouse ≥ 95 + k6 + **Go-Live `mundonettech.co`**. | `[ ]` |
| **Hito 2 — Escala** | **Fase 4B — CRM 360 y Canal B2B** | `F4B.1` `Contact` 360° + duplicados + tareas + retención Hábeas Data · `F4B.2` `PriceList` B2B + `/empresas` → Propuestas `BigInt` `/propuesta/[token]` → `Order` + Copiloto 0-PII. | `[ ]` |
| **Hito 2** | **Fase 5 — Lealtad, Lifecycle y Observabilidad** | `F5.1` Puntos (con reversa `EARN` en reembolso) + Referidos + Carritos abandonados · `F5.2` Lifecycle + Segmentos Ley 1581 + RFM/LTV · `F5.3` Observabilidad desacoplada + Alertas + Backups GPG streaming R2 + DR drill completo (`auth` + todos los buckets) + Ayuda v2. | `[ ]` |
| **Hito 2** | **Fase 6 — Omnicanal ML `MCO` + Meta CAPI** | `F6.1` OAuth PKCE serializado · `F6.2` Legacy/User Products + stock `x-version` + Full + precios `FORMULA`/`MANUAL` (zona muerta \$60k) · `F6.3` `ChannelPack`/`ChannelOrder` + `ME2`/Flex + posventa + conciliación · `F6.4` Meta Catalog + Pixel/CAPI. | `[ ]` |
| **Hito 3 (Opc.)** | **Fase 7 — WhatsApp + Agente IA** | WhatsApp Cloud API (Meta App propia) + Agente Gemini TS sobre `packages/core` + Inbox humano con *takeover*. | `[ ]` |

---

## 2. Fase Activa — Fase 1: Catálogo Tech, Media 360°/3D e Inventario WAC

- `[x]` ✅ **Fase 0 cerrada (`F0.1`–`F0.5`):** Gobernanza, Next.js 16 standalone (`'use cache'`), PG 17 + RLS *deny-by-default* + Bóveda `AES-256-GCM`, Auth OTP/HIBP/Turnstile, `/admin` MFA `aal2` + RBAC 8 roles + `pii-mask` y CI PG 17/Playwright/axe.
- `[ ]` **`F1.1` — Esquema y Dominio de Catálogo Tech (`catalog.prisma` + `@mundonettech/core` + `config/catalog-blueprint.ts`):** Marcas, Categorías N-niveles (`materializedPath`), Colecciones, Variantes `BigInt` (`gtin`/`ean` GS1, `mpn`), Atributos/Facetas (`ADR-008`), Compatibilidad, Bundles, `UrlRedirect` anti-bucles, índices parciales (`ADR-004`) y `tsvector` + `immutable_unaccent`.
- `[ ]` **`F1.2` — Pipeline Multimedia y Activos 360°/3D (`packages/media` + `ProductMedia`):** `sharp-safe` (magic bytes sin SVG, límite píxeles, `ispe` HEIC, purga EXIF), AVIF/WebP en R2 (`unoptimized: true`), `SPIN_360` y `MODEL_3D`/AR *lazy* (`ADR-007`).
- `[ ]` **`F1.3` — Inventario Multi-Bodega, Proveedores/WAC e Importador CSV (`inventory.prisma`):** `StockLocation`, `StockLevel` (`safetyStock` efectivo + locks ordenados anti-deadlock `40P01` — `ADR-013`), `SerializedUnit`, `InventoryLedger`, `Supplier`/`PurchaseOrder` (WAC) y CSV seguro.
- `[ ]` **`F1.4` — `CatalogService` Único (`'use cache'`), Storefront PDP/PLP/Comparador y Admin:** búsqueda/facetas indexadas, `ProductCard` única, comparador, PDP, vistas `/admin` RBAC+MFA, seed canónico y E2E Playwright/`@axe-core`.

---

## 3. Handoff para la siguiente sesión

- **Siguiente bloque:** **`F1.1`** en rama `feat/f1-1-catalog-domain-schema` desde `develop` (inicio de **Fase 1**).
- **Leer al iniciar:** `AGENTS.md`, `docs/{STATE,PLAN,ARCHITECTURE,DECISIONS}.md`, `config/store.config.ts` y `packages/{db,core}/README.md`.
- **Cierre dual `F1.1`:** Implementador entrega `config/catalog-blueprint.ts`, `catalog.prisma` + migración PG 17 (`BigInt` `CHECK >= 0`, índices `ADR-004`, `tsvector` + `immutable_unaccent`, RLS), validadores GS1/árbol/`UrlRedirect` en `@mundonettech/core` y `rls-matrix` en `[R]`; Auditor certifica `[x]` y fusiona en `develop`.
