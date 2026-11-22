# Estado Actual del Proyecto — MundoNetTech (`mundonettech.co`)

> **Documento vivo de Nivel 0 (≤ 120 lín., cero bitácoras).** Mapa en [`INDEX.md`](INDEX.md).

## Fotografía ejecutiva

- **Estado:** **Fases 0–4A cerradas ✅ (`Hito 1` técnico certificado; Go-Live real pendiente de externos) · Fase 4B activa: sigue `F4B.1`**.
- **Operación:** `mundonettech.co` · `MNT-YYYY-NNNN` · Retail/mayorista tech CO · **`NO_RESPONSABLE_IVA`** (`3.500 UVT`, motor dual `ADR-009`).
- **Base activa (`F0`–`F4A.3`):** Next.js 16 standalone (`'use cache'`/`connection()`), PG 17 (`96` tablas RLS, `1.677` casos), bóveda `AES-256-GCM`, MFA `aal2` + RBAC 8 roles, `@mundonettech/{core,db,integrations,media,cms,legal-co}`, DIVIPOLA, `OrderReceipt` SHA-256, SEO/XML, monitor `3.500 UVT`, posventa RMA/PQR/reseñas y gates OWASP/`55` E2E+axe/Lighthouse ≥ 96/k6/`release:verify`.

## Topología de ambientes

| Ambiente | URL / Puertos | Estado |
| --- | --- | --- |
| **LOCAL** | Next `:4010` (`:4110` E2E) · API `:54421` · PG 17 `:54422` (`:54428` tests) · Studio `:54423` · Mailpit `:54424` | Operativo (`F0.1`–`F4A.3` ✅) |
| **STG** | Rama `develop` → Preview + Supabase STG dedicado (secretos aislados de PRD) | Pendiente aprovisionamiento externo |
| **PRD** | Rama `production` → `https://mundonettech.co` + Supabase PRD + Cloudflare R2 | Bloqueado *fail-closed* (`release:verify`) hasta externos + aprobación humana |

## Capacidades operativas construidas

- **Fase 0 (`F0.1`–`F0.5` ✅):** Gobernanza, Next 16 standalone, PG 17 + RLS + Bóveda `AES-256-GCM`, Auth OTP/HIBP/Turnstile, `/admin` MFA `aal2` + RBAC 8 roles + `pii-mask` y CI.
- **Fase 1 (`F1.1`–`F1.4` ✅):** Catálogo (`BigInt`, GS1/EAN, `tsvector`), `media` (R2 + 360°/3D *lazy*), inventario multi-bodega (`safetyStock`, `IMEI`, WAC, CSV), `CatalogService`, PDP/PLP/Comparador y admin MFA.
- **Fase 2 (`F2.1`–`F2.3` ✅):** `cms` (`StoreSettings`, 6 bloques Zod, R2, `/pagina/[slug]` PPR, Live Edit `aal2`, SERP/OG), `legal-co` (8 docs, 18 festivos CO, SLA), `UrlRedirect` MFA y SEO/Merchant XML.
- **Fase 3 (`F3.1`–`F3.4` ✅):** Carrito/mayorista/bundles/cupones/`/pagar/[token]`, checkout DANE/Flex/*Click & Collect* + IVA dual + `OrderReceipt` + `DomainOutbox` 0-PII, `PaymentProvider`, Aveonline/Flex, Resend/Svix/RFC 8058 y DIAN UBL.
- **Fase 4A (`F4A.1`–`F4A.3` ✅):** `/admin/{hoy,dashboard,pedidos,finanzas,posventa,resenas}` RBAC/PII, `FiscalWatchSnapshot` `3.500 UVT`, `/mi-cuenta/*` Ley 1581, `/pedido/[token]` OTP HMAC, RMA `SerializedUnit` + `OrderRefund`, PQR SLA CO, reseñas verificadas y gates OWASP/sondas, `55` E2E + axe 0 violaciones, `8` Lighthouse `96–100`, k6 (`28` éxitos/`60` rechazos/`76` invariantes) y `release:verify` STG→PRD (`ADR-034`..`036`).

## Pendientes externos de negocio (bloquean Go-Live real, no `F4B.1`)

1. Paleta definitiva y logo `.svg` de **MundoNetTech** (opera con *Tech Precision* en `config/theme.config.ts`).
2. Cuentas externas: Cloudflare (`mundonettech.co` + R2), Supabase STG/PRD, Resend, Wompi, Aveonline, proveedor DIAN y Mercado Libre `MCO`.
3. Go-Live real: razón social/NIT/dirección/teléfono, revisión jurídica, buzones legales (`docs/COMPLIANCE.md`) y aprobaciones humanas en `release:verify`.
