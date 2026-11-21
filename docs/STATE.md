# Estado Actual del Proyecto — MundoNetTech (`mundonettech.co`)

> **Documento vivo de Nivel 0 (≤ 120 lín., cero bitácoras).** Mapa en [`INDEX.md`](INDEX.md).

## Fotografía ejecutiva

- **Estado:** **Fase 1 en curso (`F1.1`–`F1.3` certificados ✅ → sigue `F1.4` `CatalogService`, Storefront y Admin)**.
- **Operación:** `mundonettech.co` · Órdenes `MNT-YYYY-NNNN` · Retail/mayorista tech multimarca en CO.
- **Régimen tributario:** inicia en **`NO_RESPONSABLE_IVA`** (`3.500 UVT`), con motor dual (`NO_RESPONSABLE_IVA` ↔ `RESPONSABLE_IVA` + topes `50`/`22` UVT tech + DIAN — `ADR-009`).
- **Base activa (`F0`–`F1.3`):** Next.js 16 standalone (`:4010`/`:4110`, `'use cache'`), PG 17 (`38` tablas RLS *deny-by-default*, `685` casos), bóveda `AES-256-GCM`, Auth/Admin MFA `aal2` + RBAC 8 roles, catálogo tech, `@mundonettech/media` e inventario WAC/seriales/CSV.

## Topología de ambientes

| Ambiente | URL / Puertos | Estado |
| --- | --- | --- |
| **LOCAL** | Next `:4010` (`:4110` E2E) · API `:54421` · PG 17 `:54422` (`:54428` tests) · Studio `:54423` · Mailpit `:54424` | Operativo y certificado (`F0.1`–`F1.3`) |
| **STG** | Rama `develop` → Preview + Supabase STG dedicado (secretos aislados de PRD) | Por aprovisionar antes de cerrar Hito 1 |
| **PRD** | Rama `production` → `https://mundonettech.co` + Supabase PRD + Cloudflare R2 | Por aprovisionar en `F4A.3` |

## Capacidades operativas construidas

- **Fase 0 cerrada (`F0.1`–`F0.5`):** ✅ Gobernanza, Next.js 16 standalone (`'use cache'`), PG 17 + RLS + Bóveda `AES-256-GCM`, Auth OTP/HIBP/Turnstile, `/admin` MFA `aal2` + RBAC 8 roles + `pii-mask` y CI PG 17/Playwright/axe.
- **Catálogo, Media e Inventario (`F1.1`–`F1.3`):** ✅ `29` modelos de dominio + `Order` en PG 17 (`BigInt` COP, GS1/EAN, `tsvector` GIN, `ProductMedia` endurecido y `rls-matrix` `685` casos), `@mundonettech/media` (`sharp-safe`, AVIF/WebP en R2 y visores `Spin360`/`Model3d` *lazy* WCAG AA) e inventario multi-bodega (`safetyStock`, locks anti-deadlock, paridad PG 17 `StockLevel`↔`SerializedUnit` con `IMEI` global, compras WAC y CSV seguro).
- **Bloques `F1.4`–`F6`:** pendientes según [`PLAN.md`](PLAN.md) (siguiente: **`F1.4`**).

## Pendientes externos de negocio (no bloquean Fase 1–2)

1. Paleta definitiva y logo `.svg` de **MundoNetTech** (opera con *Tech Precision* en `config/theme.config.ts`).
2. Cuentas para Fase 3 / 6: Cloudflare (`mundonettech.co` + R2), Resend, Wompi, Aveonline y Mercado Libre `MCO`.
