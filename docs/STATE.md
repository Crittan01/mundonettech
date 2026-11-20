# Estado Actual del Proyecto — MundoNetTech (`mundonettech.co`)

> **Documento vivo de Nivel 0 (≤ 120 lín., cero bitácoras).** Mapa en [`INDEX.md`](INDEX.md).

## Fotografía ejecutiva

- **Estado:** **Fase 0 en curso (`F0.1`–`F0.4` certificados → sigue `F0.5` para cerrar Fase 0)**.
- **Operación:** `mundonettech.co` · Órdenes `MNT-YYYY-NNNN` · Retail/mayorista tech multimarca en CO.
- **Régimen tributario:** inicia en **`NO_RESPONSABLE_IVA`** (`3.500 UVT`), con motor dual (`NO_RESPONSABLE_IVA` ↔ `RESPONSABLE_IVA` + UVT tech + DIAN — `ADR-009`).
- **Fundación (`F0.1`–`F0.4`):** Next.js 16 (`:4010`, `proxy.ts`, `'use cache'`), PG 17 (`:54421..54424`), RLS 100 % *deny-by-default*, bóveda `AES-256-GCM`, Auth cliente OTP/HIBP/Turnstile y núcleo `/admin` con **MFA TOTP `aal2`**, RBAC 8 roles (3 anillos) y PII mask en verde.

## Topología de ambientes

| Ambiente | URL / Puertos | Estado |
| --- | --- | --- |
| **LOCAL** | Next `:4010` (`:4110` E2E) · API `:54421` · PG 17 `:54422` · Studio `:54423` · Mailpit `:54424` | Operativo y verificado (`F0.2`–`F0.4`) |
| **STG** | Rama `develop` → Preview + Supabase STG dedicado (secretos aislados de PRD) | Por aprovisionar antes de cerrar Hito 1 |
| **PRD** | Rama `production` → `https://mundonettech.co` + Supabase PRD + Cloudflare R2 | Por aprovisionar en `F4A.3` |

## Capacidades operativas construidas

- **Gobernanza (`F0.1`):** ✅ `AGENTS.md`, `README.md`, `docs/{INDEX,STATE,PLAN,ARCHITECTURE,DECISIONS}.md`.
- **Monorepo y Guardas (`F0.2`):** ✅ `@mundonettech/config`, `packages/*`, `apps/web` (`:4010`, `'use cache'`), ESLint (`client-ip`, `sharp-safe`) y guardas semánticas/anti-stub.
- **PG 17, RLS y Bóveda (`F0.3`):** ✅ 9 modelos Prisma 7, cadena DDL única, `enforce_rls_on_new_table`, PostgREST revocado, primitivas `SKIP LOCKED`/idempotencia (`acquired`), bóveda `AES-256-GCM` AAD y `verify-security-posture`.
- **Borde, Auth y Admin MFA `aal2` (`F0.4`):** ✅ `proxy.ts` (CSP/headers, timeouts HMAC 30m/12h admin y 30d cliente), Auth cliente (OTP 6 dígitos, HIBP, Turnstile), `/admin` (`aal2` TOTP, códigos HMAC, step-up ≤ 10m, RBAC 8 roles/3 anillos, `pii-mask`, `usuarios`/`seguridad`/`auditoria`) y `docs/SECURITY.md`.
- **CI/RLS Matrix/E2E (`F0.5`) y Fases `F1`–`F6`:** pendientes según [`PLAN.md`](PLAN.md).

## Pendientes externos de negocio (no bloquean Fase 0–2)

1. Paleta definitiva y logo `.svg` de **MundoNetTech** (inicia con *Tech Precision* en `config/theme.config.ts`).
2. Cuentas para Fase 3 / 6: Cloudflare (`mundonettech.co` + R2), Resend, Wompi, Aveonline y Mercado Libre `MCO`.
