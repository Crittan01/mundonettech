# Plan Maestro Vivo — MundoNetTech (`mundonettech.co`)

> **Workboard vivo de Nivel 0 (≤ 160 lín.).** Estados: `[ ]` pendiente · `[R]` implementado (en auditoría) · `[x]` certificado. Expande solo la fase activa; compacta fases cerradas a 1 línea `✅`. Detalle en [`ARCHITECTURE.md`](ARCHITECTURE.md).

## 1. Mapa Ejecutivo de Hitos y Fases

| Hito | Fase | Alcance resumido | Estado |
| --- | --- | --- | :---: |
| **Hito 1 — Go-Live** | **Fase 0 — Fundación, Seguridad y Shell Admin** | Gobernanza, Next 16, PG 17 `BigInt` + RLS + Bóveda + Outbox, Auth + Admin **MFA `aal2`** + RBAC 8 roles + PII mask y CI/Gates (`F0.1`–`F0.5`). | `[x]` |
| **Hito 1** | **Fase 1 — Catálogo Tech, Media 360°/3D e Inventario WAC** | Catálogo/Facetas/GS1/Bundles (`F1.1`), `packages/media` R2/360°/3D (`F1.2`), Multi-bodega WAC/CSV (`F1.3`), `CatalogService` `'use cache'`/PDP/Admin (`F1.4`). | `[x]` |
| **Hito 1** | **Fase 2 — CMS v3, SEO y Legal CO** | CMS Zod + `StoreSettings` + R2 (`F2.1`), `/pagina/[slug]` PPR + Live Edit + SERP (`F2.2`), `packages/legal-co` + `UrlRedirect` + JSON-LD/Sitemap/Merchant XML (`F2.3`). | `[x]` |
| **Hito 1** | **Fase 3 — Carrito, Checkout, IVA Dual, Pagos y Logística** | `F3.1` Carrito/Mayorista/Bundles/Cupones/`/pagar/[token]` · `F3.2` Checkout DANE + IVA Dual/UVT + `OrderReceipt` + `Shipment`/`OrderRefund` + Outbox · `F3.3` Bóveda + `PaymentProvider` · `F3.4` Aveonline *pick & pack* + Claim Idempotente + Flex + Resend/Svix + DIAN. | `[ ]` |
| **Hito 1** | **Fase 4A — Operación, RMA/Seriales y Lanzamiento** | `F4A.1` `/admin/{hoy,dashboard,pedidos,finanzas}` (`OrderRefund`) + `3.500 UVT` · `F4A.2` `/mi-cuenta/*` + `/pedido/[token]` 2FA + RMA (`SerializedUnit`) + PQR SLA + Reseñas · `F4A.3` OWASP + E2E + axe + Lighthouse ≥ 95 + k6 + **Go-Live**. | `[ ]` |
| **Hito 2 — Escala** | **Fase 4B — CRM 360 y Canal B2B** | `F4B.1` `Contact` 360° + duplicados + tareas + retención Hábeas Data · `F4B.2` `PriceList` B2B + `/empresas` → `/propuesta/[token]` `BigInt` → `Order` + Copiloto 0-PII. | `[ ]` |
| **Hito 2** | **Fase 5 — Lealtad, Lifecycle y Observabilidad** | `F5.1` Puntos (reversa `EARN`) + Referidos + Abandonados · `F5.2` Lifecycle + Segmentos Ley 1581 + RFM/LTV · `F5.3` Salud + Alertas + Backups GPG R2 streaming + DR drill + Ayuda v2. | `[ ]` |
| **Hito 2** | **Fase 6 — Omnicanal ML `MCO` + Meta CAPI** | `F6.1` OAuth PKCE · `F6.2` User Products + `x-version` + Full + precios (zona muerta \$60k) · `F6.3` `ChannelPack`/`ChannelOrder` + `ME2`/Flex + conciliación · `F6.4` Meta Catalog + CAPI. | `[ ]` |
| **Hito 3 (Opc.)** | **Fase 7 — WhatsApp + Agente IA** | WhatsApp Cloud API + Agente Gemini TS sobre `packages/core` + Inbox humano con *takeover*. | `[ ]` |

---

## 2. Fase Activa — Fase 3: Carrito, Checkout, IVA Dual, Pagos y Logística

- `[x]` ✅ **Fase 0 (`F0.1`–`F0.5`):** Gobernanza, Next 16 (`'use cache'`), PG 17 + RLS + Bóveda `AES-256-GCM`, Auth OTP/HIBP/Turnstile, `/admin` MFA `aal2` + RBAC 8 roles + `pii-mask` y CI.
- `[x]` ✅ **Fase 1 (`F1.1`–`F1.4`):** Catálogo PG 17 (`BigInt`, GS1/EAN, `tsvector`), `packages/media` (R2 + 360°/3D *lazy*), inventario WAC/seriales/CSV, `CatalogService`, PDP/PLP/Comparador y admin (`ADR-023`..`ADR-026`).
- `[x]` ✅ **Fase 2 (`F2.1`–`F2.3`):** CMS v3 (`StoreSettings`, 6 bloques Zod, R2, `/pagina/[slug]` PPR, Live Edit `aal2`, SERP/OG), `packages/legal-co` (8 docs, 18 festivos CO, Ley 1480/2439/1581), `UrlRedirectService` MFA y SEO/Merchant XML (`ADR-027`..`ADR-029`).
- `[x]` ✅ **`F3.1` — Carrito, Mayorista, Bundles, Cupones y Venta Asistida:** `Cart`/`CartItem`, `WholesaleTier` N-niveles, `Bundle`, `Coupon`/`CouponUsage`, `/carrito`, `/admin/{precios,venta-asistida}` MFA y `/pagar/[token]` (`ADR-030`).
- `[x]` ✅ **`F3.2` — Checkout 3 Pasos, IVA Dual/UVT, `OrderReceipt` y `DomainOutbox`:** DANE + *Click & Collect*, `Cart` → `Order` idempotente + `Consent`, topes `50`/`22` UVT (`OrderItemTaxLine[]`), reserva WAC, `/recibo/[token]` SHA-256, `Shipment`/`OrderRefund` `1:N` y outbox 0-PII (`ADR-031`).
- `[x]` ✅ **`F3.3` — Bóveda `/admin/integraciones` y Pasarelas Agnósticas:** wizard MFA `AES-256-GCM`, `/admin/pagos` MFA, `PaymentProvider` (`refund()`/`void()`), Wompi Web Checkout/webhooks firmados, COD + `BlockedIdentity`/remesas, transferencia MFA y `StoreCredit` (`ADR-032`).
- `[R]` **`F3.4` — Logística *Pick & Pack* Asíncrona, Multi-Bulto, Flex, Emails y Puerto DIAN:** `ShippingProvider` (Aveonline asíncrono + **Claim Idempotente** `ADR-012` + `ShipmentPackage[]` multi-bulto + `LocalDeliveryZone` Flex), `EmailProvider` (Resend + Svix monotónico + baja RFC 8058), `InvoiceProvider` DIAN UBL 2.1 / Nota Crédito, worker `DomainOutbox` 0-PII y vistas operativas MFA (`ADR-033`).

---

## 3. Handoff para la siguiente sesión

- **Siguiente turno — Auditor/Certificador (`F3.4` `[R]`):** auditar `feat/f3-4-async-pick-pack-shipping-emails-dian`: 11 tablas RLS, claims multi-bulto/Aveonline con conciliación, Flex E6/DANE, Resend/Svix + baja RFC 8058, DIAN UBL 2.1/notas crédito y worker `DomainOutbox` 0-PII (`ADR-033`). Implementador: `make check`, 154 pruebas, 1.439 denegaciones RLS en 82 tablas, build y 44 E2E. Reejecutar gates, certificar, actualizar `STATE` y abrir PR; proveedores externos no verificados en vivo.
