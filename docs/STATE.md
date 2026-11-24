# Estado Actual del Proyecto — MundoNetTech (`mundonettech.co`)

> **Documento vivo de Nivel 0 (≤ 120 lín., cero bitácoras).** Mapa en [`INDEX.md`](INDEX.md).

## Fotografía ejecutiva

- **Estado:** **Fases 0–6 ✅ (`F0.1`–`F6.4`) · Activo: Auditoría Integral Pre-Calle `A1`–`A6` (`A1` sigue) → luego `M1`–`M4` · `Fase 7` congelada**.
- **Operación:** `mundonettech.co` · `MNT-YYYY-NNNN` · Retail/mayorista tech CO · **`NO_RESPONSABLE_IVA`** (`3.500 UVT`, `ADR-009`).
- **Base:** Next 16 standalone (`94` rutas), PG 17 (`131` tablas RLS/`2.272` denegaciones), `BigInt`, bóveda AES-256-GCM, MFA `aal2` + RBAC 8 roles, R2/WAC/IMEI, CMS/legal/SEO, checkout/pagos/logística/DIAN, CRM/B2B, lifecycle, salud/DR, ML `MCO` y Meta Catalog/CAPI (`ADR-001`..`045`).

## Topología de ambientes

| Ambiente | URL / Puertos | Estado |
| --- | --- | --- |
| **LOCAL** | Next `:4010` (`:4110` E2E) · API `:54421` · PG 17 `:54422` (`:54428` tests) · Studio `:54423` · Mailpit `:54424` | Operativo (`F0.1`–`F6.4` ✅) |
| **STG** | Rama `develop` → Preview + Supabase STG dedicado (secretos aislados de PRD) | Tras cerrar `A1`–`A6` + `M1` |
| **PRD** | Rama `production` → `https://mundonettech.co` + Supabase PRD + Cloudflare R2 | Bloqueado *fail-closed* (`release:verify`) hasta `M3` |

## Capacidades construidas

- **Fases 0–3 ✅:** Next 16/PG 17/RLS/MFA/bóveda, catálogo/media R2/WAC, CMS/legal/SEO, carrito/checkout `BigInt` + Outbox 0-PII, pagos, Aveonline/Flex, Resend/Svix y DIAN (`ADR-019`..`033`).
- **Fases 4A–4B ✅:** operación/finanzas, `3.500 UVT`, cuenta/invitados OTP, RMA/seriales, PQR/reseñas, gates OWASP/E2E+axe/Lighthouse/k6, CRM 360, B2B y Copiloto 0-PII (`ADR-034`..`038`).
- **Fases 5–6 ✅:** puntos/referidos, segmentos/journeys/RFM-LTV, salud, backups GPG R2, DR, Ayuda v2, Mercado Libre `MCO` (OAuth PKCE, User Products, ME2/Flex/Full, ledger) y Meta Catalog/CAPI (`ADR-039`..`045`).

## Secuencia hacia Producción (`A1`–`A6` → `M1`–`M4` → `Fase 7`)

1. **`A1`–`A6` Auditoría Integral (activa):** código muerto/cableado/caché (`A1`), seguridad/RBAC/MFA/0-PII (`A2`), PG 17/locks (`A3`), cuadre `BigInt`/IVA/Outbox (`A4`), UI/a11y (`A5`) y DR/CI (`A6`).
2. **`M1`–`M4` Calle:** rodaje `:4010` + marca (`M1`), `STG` (`M2`), Go-Live `mundonettech.co` (`M3`) y Meta/ML `MCO` (`M4`), habilitando `Fase 7`.
