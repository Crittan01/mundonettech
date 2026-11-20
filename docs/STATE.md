# Estado Actual del Proyecto — MundoNetTech (`mundonettech.co`)

> **Documento vivo de Nivel 0 (≤ 120 líneas, cero bitácoras fechadas).** Mapa completo en [`INDEX.md`](INDEX.md).

## Fotografía ejecutiva

- **Estado:** **Fase 0 en curso (`F0.1`–`F0.2` certificados → sigue `F0.3`)**.
- **Operación:** `mundonettech.co` · Órdenes `MNT-YYYY-NNNN` · Retail y mayorista de tecnología y accesorios multimarca en CO.
- **Régimen tributario:** inicia en **`NO_RESPONSABLE_IVA`** (`3.500 UVT`), con motor dual (`NO_RESPONSABLE_IVA` ↔ `RESPONSABLE_IVA` + UVT tech + puerto DIAN — `ADR-009`).
- **Fundación (`F0.1`–`F0.2`):** monorepo `pnpm` + Turborepo (`:4010`), Next.js 16 (`standalone`, `cacheComponents`, `'use cache'`), tokens *Tech Precision* y guardas CI en verde.

## Topología de ambientes

| Ambiente | URL / Puertos | Estado |
| --- | --- | --- |
| **LOCAL** | Next `:4010` (`:4110` E2E) operativo · Supabase API `:54421` · PG 17 `:54422` · Studio `:54423` · Mailpit `:54424` | Web activa (`F0.2`); PG 17 local en `F0.3` |
| **STG** | Rama `develop` → Preview + Supabase STG dedicado (aislamiento total de secretos respecto a PRD) | Por aprovisionar antes de cerrar Hito 1 |
| **PRD** | Rama `production` → `https://mundonettech.co` + Supabase PRD + Cloudflare R2 | Por aprovisionar en `F4A.3` |

## Capacidades operativas construidas

- **Gobernanza y arquitectura (`F0.1`):** ✅ `AGENTS.md`, `README.md`, `docs/{INDEX,STATE,PLAN,ARCHITECTURE,DECISIONS}.md`.
- **Monorepo, Next.js 16 y Guardas CI (`F0.2`):** ✅ `@mundonettech/config` (`store`, `theme`), esqueletos `packages/{db,core,media,cms,integrations,legal-co}`, `apps/web` (`:4010`, `(storefront)` cacheado), ESLint 9 (`client-ip`, `sharp-safe`), guardas (`docs`, `git`, `language`, `boundaries`/tokens) y tests negativos.
- **BD/RLS/Bóveda, Seguridad/Admin, Catálogo, CMS, Checkout y Omnicanal (`F0.3`–`F6`):** pendientes según [`PLAN.md`](PLAN.md).

## Pendientes externos de negocio (no bloquean Fase 0–2)

1. Definir paleta definitiva y logotipo vectorial `.svg` de **MundoNetTech** (inicia con preset semántico *Tech Precision* en `config/theme.config.ts`).
2. Cuentas propias del comercio para conectar en Fase 3 / Fase 6: Cloudflare (`mundonettech.co` + R2), Resend (`mail.mundonettech.co`), Wompi, Aveonline y App DevCenter Mercado Libre `MCO`.
