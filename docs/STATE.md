# Estado Actual del Proyecto — MundoNetTech (`mundonettech.co`)

> **Documento vivo de Nivel 0 (≤ 120 lín., cero bitácoras).** Mapa en [`INDEX.md`](INDEX.md).

## Fotografía ejecutiva

- **Estado:** **Código Fases 0–6 ✅ (`Hito 1` y `Hito 2` certificados en CI) · Activo: Maduración Operativa `M1`–`M4` · `Fase 7` congelada hasta estabilizar operación real**.
- **Operación:** `mundonettech.co` · `MNT-YYYY-NNNN` · Retail/mayorista tech CO · **`NO_RESPONSABLE_IVA`** (`3.500 UVT`, `ADR-009`).
- **Base:** Next 16 standalone, PG 17 (`131` tablas RLS/`2.272` denegaciones), `BigInt`, bóveda AES-256-GCM, MFA `aal2` + RBAC 8 roles, R2/WAC/IMEI, CMS/legal/SEO, checkout/pagos/logística/DIAN, CRM/B2B, lifecycle, salud/DR, ML `MCO` y Meta Catalog/CAPI (`ADR-042`..`045`).

## Topología de ambientes

| Ambiente | URL / Puertos | Estado |
| --- | --- | --- |
| **LOCAL** | Next `:4010` (`:4110` E2E) · API `:54421` · PG 17 `:54422` (`:54428` tests) · Studio `:54423` · Mailpit `:54424` | Operativo (`F0.1`–`F6.4` ✅) |
| **STG** | Rama `develop` → Preview + Supabase STG dedicado (secretos aislados de PRD) | Pendiente aprovisionamiento externo |
| **PRD** | Rama `production` → `https://mundonettech.co` + Supabase PRD + Cloudflare R2 | Bloqueado *fail-closed* (`release:verify`) hasta externos + aprobación humana |

## Capacidades operativas construidas

- **Fases 0–3 ✅:** fundación Next/PG/RLS/MFA/bóveda, catálogo/media/WAC, CMS/legal/SEO, carrito/checkout `BigInt` + Outbox 0-PII, pagos, Aveonline/Flex, Resend/Svix y DIAN (`ADR-019`..`033`).
- **Fase 4A ✅:** operación/finanzas, `3.500 UVT`, cuenta/invitados OTP, RMA/seriales, PQR/reseñas y gates OWASP/E2E+axe/Lighthouse/k6 (`ADR-034`..`036`).
- **Fase 4B ✅:** CRM 360, organizaciones/precios `BigInt`, fusiones MFA, Hábeas Data, B2B `/empresas` → propuesta → `Order` y Copiloto 0-PII (`ADR-037`..`038`).
- **Fase 5 ✅:** lealtad/referidos, segmentos/journeys/RFM-LTV, salud, backups GPG multipart R2, DR aislado y Ayuda v2 (`ADR-039`..`041`).
- **Fase 6 ✅:** OAuth PKCE `S256`, User Products/precios/`x-version`/Full y packs/órdenes/`ChannelShipment` ME2/Flex/Full con reserva/descuento serializado y `ChannelLedgerEntry` append-only MFA/RLS (`ADR-042`..`044`); Meta Catalog CSV validado y CAPI `Purchase` con consentimiento `ADVERTISING`, `event_id`, bóveda, purga de hashes (incluidos estados inciertos) y conciliación/descarte MFA (`ADR-045`).

## Secuencia de maduración real (`M1` → `M4`; requisito previo a `Fase 7`)

1. **`M1` Rodaje `LOCAL` + marca:** recorrido humano completo en `:4010`, catálogo/medios reales y logo `.svg` + paleta (`config/theme.config.ts`).
2. **`M2`–`M3` Core vivo (`STG` → `PRD`):** NIT/razón social/dirección/buzones y revisión jurídica (`COMPLIANCE.md`); Cloudflare/R2, Supabase STG/PRD, Resend, Wompi, Aveonline (+ DIAN) y `release:verify`.
3. **`M4` Canales → `Fase 7`:** encender Merchant + Meta Catalog/CAPI (dominio/portafolio verificados en Meta Business) y luego ML `MCO`; recién estabilizado se abre `F7.1`–`F7.3`.
