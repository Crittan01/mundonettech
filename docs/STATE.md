# Estado Actual del Proyecto — MundoNetTech (`mundonettech.co`)

> **Documento vivo de Nivel 0 (≤ 120 lín., cero bitácoras).** Mapa en [`INDEX.md`](INDEX.md).

## Fotografía ejecutiva

- **Estado:** **Fase 2 en curso (`F2.1`–`F2.2` ✅ en `develop`) → siguiente bloque: `F2.3` (Legal CO/SEO técnico)**.
- **Operación:** `mundonettech.co` · Órdenes `MNT-YYYY-NNNN` · Retail/mayorista tech multimarca en CO.
- **Régimen tributario:** inicia en **`NO_RESPONSABLE_IVA`** (`3.500 UVT`), con motor dual (`NO_RESPONSABLE_IVA` ↔ `RESPONSABLE_IVA` + topes `50`/`22` UVT tech + DIAN — `ADR-009`).
- **Base activa (`F0`–`F2.2`):** Next.js 16 standalone (`:4010`/`:4110`, `'use cache'`), PG 17 (`43` tablas RLS *deny-by-default*, `770` casos), bóveda `AES-256-GCM`, Auth/Admin MFA `aal2` + RBAC 8 roles, `CatalogService` único, PDP/PLP/Comparador, `@mundonettech/media`, inventario WAC/CSV y `@mundonettech/cms` (`StoreSettings`, bloques Zod versionados, mediateca R2, `/pagina/[slug]` PPR, Live Edit `aal2` y SERP/OG).

## Topología de ambientes

| Ambiente | URL / Puertos | Estado |
| --- | --- | --- |
| **LOCAL** | Next `:4010` (`:4110` E2E) · API `:54421` · PG 17 `:54422` (`:54428` tests) · Studio `:54423` · Mailpit `:54424` | Operativo y certificado (`F0.1`–`F2.2`) |
| **STG** | Rama `develop` → Preview + Supabase STG dedicado (secretos aislados de PRD) | Por aprovisionar antes de cerrar Hito 1 |
| **PRD** | Rama `production` → `https://mundonettech.co` + Supabase PRD + Cloudflare R2 | Por aprovisionar en `F4A.3` |

## Capacidades operativas construidas

- **Fase 0 cerrada (`F0.1`–`F0.5`):** ✅ Gobernanza, Next.js 16 standalone (`'use cache'`), PG 17 + RLS + Bóveda `AES-256-GCM`, Auth OTP/HIBP/Turnstile, `/admin` MFA `aal2` + RBAC 8 roles + `pii-mask` y CI PG 17/Playwright/axe.
- **Fase 1 cerrada (`F1.1`–`F1.4`):** ✅ Catálogo tech (`29` modelos + `Order` en PG 17, `BigInt` COP, GS1/EAN, `tsvector` GIN), `@mundonettech/media` (`sharp-safe`, R2, `Spin360`/`Model3d` *lazy*), inventario multi-bodega (`safetyStock`, locks, `IMEI`, WAC y CSV), `CatalogService` (`'use cache'`), PDP/PLP/Comparador, `/admin/catalogo` MFA y seed.
- **Fase 2 en curso (`F2.1`–`F2.2` ✅):** `@mundonettech/cms` (6 bloques Zod revalidados tras `{{tokens}}`, historial inmutable/programación, `StoreSettings`, mediateca R2 y `770` casos RLS), `/pagina/[slug]` PPR, Live Edit `aal2` + step-up en `<Suspense>` y SERP/OG (`ADR-027`..`ADR-028`). Siguiente: **`F2.3`**.

## Pendientes externos de negocio (no bloquean Fase 2)

1. Paleta definitiva y logo `.svg` de **MundoNetTech** (opera con *Tech Precision* en `config/theme.config.ts`).
2. Cuentas para Fase 3 / 6: Cloudflare (`mundonettech.co` + R2), Resend, Wompi, Aveonline y Mercado Libre `MCO`.
