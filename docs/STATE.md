# Estado Actual del Proyecto — MundoNetTech (`mundonettech.co`)

> **Documento vivo de Nivel 0 (≤ 120 lín., cero bitácoras).** Mapa en [`INDEX.md`](INDEX.md).

## Fotografía ejecutiva

- **Estado:** **Fases 0–6 ✅ (`F0.1`–`F6.4`) · Activo: Auditoría Integral Pre-Calle `A1`–`A10` (`A1`–`A5` ✅, sigue `A6`) → `M1`–`M4` · `Fase 7` congelada**.
- **Operación:** `mundonettech.co` · `MNT-YYYY-NNNN` · Retail/mayorista tech CO · **`NO_RESPONSABLE_IVA`** (`3.500 UVT`, `ADR-009`).
- **Inventario real:** `621` fuentes AST (`142` módulos `packages/*`), `29` págs. Cliente, `43` `/admin`, `24` APIs, `133` tablas PG 17 (`2.306` pruebas RLS) y `1.204` pruebas + `89` E2E (`ADR-001`..`050`).

## Topología de ambientes

| Ambiente | URL / Puertos | Estado |
| --- | --- | --- |
| **LOCAL** | Next `:4010` (`:4110` E2E) · API `:54421` · PG 17 `:54422` (`:54428` tests) · Studio `:54423` · Mailpit `:54424` | Operativo (`F0.1`–`F6.4` ✅) |
| **STG** | `develop` → Preview + Supabase STG aislado | Tras `A1`–`A10` + `M1` |
| **PRD** | `production` → `mundonettech.co` + Supabase PRD + R2 | *Fail-closed* (`release:verify`) hasta `M3` |

## Capacidades construidas

- **Fases 0–3 ✅:** Next 16/PG 17/RLS/MFA/bóveda, catálogo/media R2/WAC, CMS/legal/SEO, carrito/checkout `BigInt` + Outbox 0-PII, pagos, Aveonline/Flex, Resend/Svix y DIAN.
- **Fases 4A–4B ✅:** operación/finanzas, `3.500 UVT`, cuenta/invitados OTP, RMA/seriales, PQR/reseñas, gates OWASP/E2E+axe/Lighthouse/k6, CRM 360, B2B y Copiloto 0-PII.
- **Fases 5–6 ✅:** puntos/referidos, segmentos/journeys/RFM-LTV, salud, backups GPG R2, DR, Ayuda v2, Mercado Libre `MCO` y Meta Catalog/CAPI.

## Secuencia hacia Producción (`A1`–`A10` → `M1`–`M4` → `Fase 7`)

1. **`A1`–`A10` Auditoría Integral (activa):** `A1`–`A5` ✅ (AST/Caché, Zero-Trust, PG 17, Catálogo/Media/CMS y Carrito/Pagos/Logística/DIAN) · siguen `A6`–`A8` espejo `Admin ↔ Cliente` y `A9`–`A10` UX/Ops.
2. **`M1`–`M4` Calle:** rodaje `:4010` + marca (`M1`), `STG` (`M2`), Go-Live `mundonettech.co` (`M3`) y Meta/ML `MCO` (`M4`), habilitando `Fase 7`.
