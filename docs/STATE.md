# Estado Actual del Proyecto — MundoNetTech (`mundonettech.co`)

> **Documento vivo de Nivel 0 (≤ 120 lín., cero bitácoras).** Mapa en [`INDEX.md`](INDEX.md).

## Fotografía ejecutiva

- **Estado:** **Fases 0–4B ✅ (`Hito 1` técnico certificado; Go-Live pendiente de externos) · `F5.1` ✅ · sigue `F5.2`**.
- **Operación:** `mundonettech.co` · `MNT-YYYY-NNNN` · Retail/mayorista tech CO · **`NO_RESPONSABLE_IVA`** (`3.500 UVT`, `ADR-009`).
- **Base activa (`F0`–`F5.1`):** Next 16 standalone (`'use cache'`/`connection()`), PG 17 (`111` tablas RLS, `1.932` casos), bóveda `AES-256-GCM`, MFA `aal2` + RBAC 8 roles, `@mundonettech/{core,db,integrations,media,cms,legal-co}`, DIVIPOLA, `OrderReceipt` SHA-256, SEO/XML, `3.500 UVT`, RMA/PQR/reseñas, CRM 360 + B2B/Copiloto 0-PII, lealtad/referidos/abandonados y OWASP/`60` E2E+axe/Lighthouse ≥ 96/k6/`release:verify`.

## Topología de ambientes

| Ambiente | URL / Puertos | Estado |
| --- | --- | --- |
| **LOCAL** | Next `:4010` (`:4110` E2E) · API `:54421` · PG 17 `:54422` (`:54428` tests) · Studio `:54423` · Mailpit `:54424` | Operativo (`F0.1`–`F5.1` ✅) |
| **STG** | Rama `develop` → Preview + Supabase STG dedicado (secretos aislados de PRD) | Pendiente aprovisionamiento externo |
| **PRD** | Rama `production` → `https://mundonettech.co` + Supabase PRD + Cloudflare R2 | Bloqueado *fail-closed* (`release:verify`) hasta externos + aprobación humana |

## Capacidades operativas construidas

- **Fase 0–3 (`F0.1`–`F3.4` ✅):** Next 16 standalone, PG 17 + RLS + Bóveda, Auth/MFA `aal2` + RBAC 8 roles, Catálogo `BigInt`/GS1/`tsvector`, `media` R2/360°/3D, multi-bodega WAC/IMEI, `cms` Zod/PPR/Live Edit, `legal-co`, `UrlRedirect`/SEO XML, carrito/mayorista/cupones/`/pagar/[token]`, checkout DANE/Flex + IVA dual + `OrderReceipt` + Outbox 0-PII, pagos, Aveonline/Flex, Resend/Svix y DIAN UBL (`ADR-019`..`033`).
- **Fase 4A (`F4A.1`–`F4A.3` ✅):** `/admin/{hoy,dashboard,pedidos,finanzas,posventa,resenas}` RBAC/PII, `3.500 UVT`, `/mi-cuenta/*` Ley 1581, `/pedido/[token]` OTP, RMA `SerializedUnit` + `OrderRefund`, PQR SLA, reseñas y gates OWASP/E2E+axe/Lighthouse `96–100`/k6/`release:verify` (`ADR-034`..`036`).
- **Fase 4B (`F4B.1`–`F4B.2` ✅):** `Organization` + `PriceList` `BigInt`, `Contact` 360°, fusiones MFA reversibles, `Task` + `/admin/hoy`, Hábeas Data bidireccional, `/empresas` → `/propuesta/[token]` → `Order` B2B y Copiloto 0-PII (`ADR-037`..`038`).
- **Fase 5 (`F5.1` ✅):** `LoyaltyTxn` (`EARN` + reversa reembolsos/`VOID` + `FORFEIT`), referidos (`__Host-mnt_referral`), `/mi-cuenta/beneficios`, `/admin/fidelizacion` y recuperación `AbandonedCart` Ley 1581 + RFC 8058 (`ADR-039`).

## Pendientes externos de negocio (bloquean Go-Live real, no `F5.2`)

1. Paleta definitiva y logo `.svg` de **MundoNetTech** (opera con *Tech Precision* en `config/theme.config.ts`).
2. Cuentas externas: Cloudflare (`mundonettech.co` + R2), Supabase STG/PRD, Resend, Wompi, Aveonline, proveedor DIAN y Mercado Libre `MCO`.
3. Go-Live real: razón social/NIT/dirección/teléfono, revisión jurídica, buzones legales (`docs/COMPLIANCE.md`) y aprobaciones humanas en `release:verify`.
