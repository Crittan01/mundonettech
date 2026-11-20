# Estado Actual del Proyecto — MundoNetTech (`mundonettech.co`)

> **Documento vivo de Nivel 0 (≤ 120 lín., cero bitácoras).** Mapa en [`INDEX.md`](INDEX.md).

## Fotografía ejecutiva

- **Estado:** **Fase 0 certificada (`F0.1`–`F0.5` ✅) → inicia Fase 1 (`F1.1` Catálogo Tech)**.
- **Operación:** `mundonettech.co` · Órdenes `MNT-YYYY-NNNN` · Retail/mayorista tech multimarca en CO.
- **Régimen tributario:** inicia en **`NO_RESPONSABLE_IVA`** (`3.500 UVT`), con motor dual (`NO_RESPONSABLE_IVA` ↔ `RESPONSABLE_IVA` + UVT tech + DIAN — `ADR-009`).
- **Fundación (`F0.1`–`F0.5`):** Next.js 16 standalone (`:4010`/`:4110`, `proxy.ts`, `'use cache'`), PG 17 (`:54421..54428`), RLS *deny-by-default* (174 casos), bóveda `AES-256-GCM`, Auth OTP/HIBP/Turnstile, `/admin` **MFA TOTP `aal2`** + RBAC 8 roles + PII mask y CI PG 17 + Playwright/`@axe-core` en verde.

## Topología de ambientes

| Ambiente | URL / Puertos | Estado |
| --- | --- | --- |
| **LOCAL** | Next `:4010` (`:4110` E2E) · API `:54421` · PG 17 `:54422` (`:54428` tests) · Studio `:54423` · Mailpit `:54424` | Operativo y certificado (`F0.1`–`F0.5`) |
| **STG** | Rama `develop` → Preview + Supabase STG dedicado (secretos aislados de PRD) | Por aprovisionar antes de cerrar Hito 1 |
| **PRD** | Rama `production` → `https://mundonettech.co` + Supabase PRD + Cloudflare R2 | Por aprovisionar en `F4A.3` |

## Capacidades operativas construidas

- **Fase 0 cerrada (`F0.1`–`F0.5`):** ✅ Gobernanza viva, `@mundonettech/config`, `packages/*`, `apps/web` standalone (`'use cache'`), 9 modelos Prisma 7 en PG 17, `enforce_rls_on_new_table`, PostgREST revocado, `SKIP LOCKED`/idempotencia (`acquired`), bóveda `AES-256-GCM`, `proxy.ts` (CSP/HSTS/HMAC), Auth cliente OTP/HIBP/Turnstile, `/admin` MFA TOTP `aal2` + códigos HMAC + step-up ≤ 10m + RBAC 8 roles + `pii-mask`, bloqueo anti-PRD/`EMAIL_SEND_DISABLED=1`, `rls-matrix` (174 casos), Vitest/Playwright/`@axe-core`, `ci.yml` y `docs/{SECURITY,OPERATIONS}.md`.
- **Fases `F1`–`F6`:** pendientes según [`PLAN.md`](PLAN.md) (siguiente bloque: **`F1.1`**).

## Pendientes externos de negocio (no bloquean Fase 1–2)

1. Paleta definitiva y logo `.svg` de **MundoNetTech** (opera con *Tech Precision* en `config/theme.config.ts`).
2. Cuentas para Fase 3 / 6: Cloudflare (`mundonettech.co` + R2), Resend, Wompi, Aveonline y Mercado Libre `MCO`.
