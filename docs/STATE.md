# Estado Actual del Proyecto — MundoNetTech (`mundonettech.co`)

> **Documento vivo de Nivel 0 (≤ 120 lín., cero bitácoras).** Mapa en [`INDEX.md`](INDEX.md).

## Fotografía ejecutiva

- **Estado:** **Fases 0–3 cerradas ✅ · Fase 4A activa: sigue `F4A.1`**.
- **Operación:** `mundonettech.co` · `MNT-YYYY-NNNN` · Retail/mayorista tech CO · Régimen inicial **`NO_RESPONSABLE_IVA`** (`3.500 UVT`, motor dual `ADR-009`).
- **Base activa (`F0`–`F3.4`):** Next.js 16 standalone (`'use cache'`/`connection()`), PG 17 (`82` tablas RLS, `1.439` casos), bóveda `AES-256-GCM`, MFA `aal2` + RBAC 8 roles, `{Catalog,Pricing,Cart,Order,OrderRefund,OrderLifecycle,LocalDelivery}Service`, `@mundonettech/integrations` (`{Payment,Shipping,Email,Invoice}Service` + `DomainEventWorker`), DIVIPOLA, `OrderReceipt` SHA-256 y `@mundonettech/{media,cms,legal-co}` + SEO/XML.

## Topología de ambientes

| Ambiente | URL / Puertos | Estado |
| --- | --- | --- |
| **LOCAL** | Next `:4010` (`:4110` E2E) · API `:54421` · PG 17 `:54422` (`:54428` tests) · Studio `:54423` · Mailpit `:54424` | Operativo (`F0.1`–`F3.4` ✅) |
| **STG** | Rama `develop` → Preview + Supabase STG dedicado (secretos aislados de PRD) | Antes de cerrar Hito 1 |
| **PRD** | Rama `production` → `https://mundonettech.co` + Supabase PRD + Cloudflare R2 | En `F4A.3` |

## Capacidades operativas construidas

- **Fase 0 (`F0.1`–`F0.5`):** ✅ Gobernanza, Next 16 standalone, PG 17 + RLS + Bóveda `AES-256-GCM`, Auth OTP/HIBP/Turnstile, `/admin` MFA `aal2` + RBAC 8 roles + `pii-mask` y CI.
- **Fase 1 (`F1.1`–`F1.4`):** ✅ Catálogo tech (`BigInt` COP, GS1/EAN, `tsvector` GIN), `@mundonettech/media` (R2 + 360°/3D *lazy*), inventario multi-bodega (`safetyStock`, `IMEI`, WAC, CSV), `CatalogService`, PDP/PLP/Comparador y `/admin/catalogo` MFA.
- **Fase 2 (`F2.1`–`F2.3`):** ✅ `@mundonettech/cms` (`StoreSettings`, 6 bloques Zod, R2, `/pagina/[slug]` PPR, Live Edit `aal2`, SERP/OG), `@mundonettech/legal-co` (8 docs, 18 festivos CO, SLA), `UrlRedirectService` MFA y SEO/Merchant XML (`ADR-027`..`ADR-029`).
- **Fase 3 (`F3.1`–`F3.4` ✅):** carrito/mayorista/bundles/cupones/`/pagar/[token]`, checkout DANE/Flex/*Click & Collect* + IVA dual `50`/`22` UVT + `OrderReceipt` + `DomainOutbox` 0-PII, `/admin/{integraciones,pagos,logistica,comunicaciones,facturacion}` MFA + `PaymentProvider` + Aveonline multi-bulto/Flex + Resend/Svix/RFC 8058 + DIAN UBL (`ADR-030`..`ADR-033`).

## Pendientes externos de negocio (no bloquean `F4A.1`)

1. Paleta definitiva y logo `.svg` de **MundoNetTech** (opera con *Tech Precision* en `config/theme.config.ts`).
2. Cuentas Fase 3 / 6: Cloudflare (`mundonettech.co` + R2), Resend, Wompi, Aveonline, proveedor DIAN y Mercado Libre `MCO`.
3. Antes de Go-Live (`F4A.3`): razón social/NIT/dirección/teléfono, revisión jurídica y buzones legales (`docs/COMPLIANCE.md`).
