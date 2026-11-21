# Estado Actual del Proyecto — MundoNetTech (`mundonettech.co`)

> **Documento vivo de Nivel 0 (≤ 120 lín., cero bitácoras).** Mapa en [`INDEX.md`](INDEX.md).

## Fotografía ejecutiva

- **Estado:** **Fase 2 cerrada (`F2.1`–`F2.3` ✅) → inicia Fase 3 (`F3.1`: Carrito, Mayorista, Bundles, Cupones y Venta Asistida)**.
- **Operación:** `mundonettech.co` · `MNT-YYYY-NNNN` · Retail/mayorista tech CO · Régimen inicial **`NO_RESPONSABLE_IVA`** (`3.500 UVT`, motor dual `ADR-009`).
- **Base activa (`F0`–`F2.3`):** Next.js 16 standalone (`'use cache'`), PG 17 (`43` tablas RLS, `770` casos), bóveda `AES-256-GCM`, Auth/Admin MFA `aal2` + RBAC 8 roles, `CatalogService`, inventario WAC/CSV y `@mundonettech/{media,cms,legal-co}` + SEO/Merchant XML.

## Topología de ambientes

| Ambiente | URL / Puertos | Estado |
| --- | --- | --- |
| **LOCAL** | Next `:4010` (`:4110` E2E) · API `:54421` · PG 17 `:54422` (`:54428` tests) · Studio `:54423` · Mailpit `:54424` | Operativo (`F0.1`–`F2.3` ✅) |
| **STG** | Rama `develop` → Preview + Supabase STG dedicado (secretos aislados de PRD) | Antes de cerrar Hito 1 |
| **PRD** | Rama `production` → `https://mundonettech.co` + Supabase PRD + Cloudflare R2 | En `F4A.3` |

## Capacidades operativas construidas

- **Fase 0 (`F0.1`–`F0.5`):** ✅ Gobernanza, Next 16 standalone, PG 17 + RLS + Bóveda `AES-256-GCM`, Auth OTP/HIBP/Turnstile, `/admin` MFA `aal2` + RBAC 8 roles + `pii-mask` y CI PG 17/Playwright/axe.
- **Fase 1 (`F1.1`–`F1.4`):** ✅ Catálogo tech (`BigInt` COP, GS1/EAN, `tsvector` GIN), `@mundonettech/media` (R2 + `Spin360`/`Model3d` *lazy*), inventario multi-bodega (`safetyStock`, `IMEI`, WAC, CSV), `CatalogService`, PDP/PLP/Comparador y `/admin/catalogo` MFA.
- **Fase 2 (`F2.1`–`F2.3`):** ✅ `@mundonettech/cms` (`StoreSettings`, 6 bloques Zod, R2, `/pagina/[slug]` PPR, Live Edit `aal2`, SERP/OG), `@mundonettech/legal-co` (8 docs, 18 festivos CO, SLA Ley 1480/2439/1581), `UrlRedirectService` MFA, JSON-LD, sitemap 50k y Merchant XML (`ADR-027`..`ADR-029`).

## Pendientes externos de negocio (no bloquean `F3.1`–`F3.2`)

1. Paleta definitiva y logo `.svg` de **MundoNetTech** (opera con *Tech Precision* en `config/theme.config.ts`).
2. Cuentas Fase 3 / 6: Cloudflare (`mundonettech.co` + R2), Resend, Wompi, Aveonline y Mercado Libre `MCO`.
3. Antes de Go-Live: razón social/NIT/dirección/teléfono, revisión jurídica y buzones legales (`docs/COMPLIANCE.md`).
