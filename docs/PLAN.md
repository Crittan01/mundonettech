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
- `[ ]` **`F3.1` — Carrito, Mayorista, Bundles, Cupones y Venta Asistida (`pricing.prisma` + `CartService`):** `Cart`/`CartItem` con revalidación vigente y stock efectivo, `WholesaleTier` (`variante > producto > categoría > global` sumando variantes del mismo `productId`), `Bundle`, `Coupon` (`BigInt`, FKs reales + `CouponUsage` con `pg_advisory_xact_lock`), UI carrito/admin MFA y `/pagar/[token]`.
- `[ ]` **`F3.2` — Checkout 3 Pasos, Motor IVA Dual/UVT, `OrderReceipt` y `DomainOutbox` (`orders.prisma`):** checkout DANE DIVIPOLA + *Click & Collect*, motor `NO_RESPONSABLE_IVA` ↔ `RESPONSABLE_IVA` + topes `50`/`22` UVT (`OrderItemTaxLine[]`, `ADR-009`), snapshots `OrderItem` (`WAC`), `OrderReceipt` cuadrado (`ADR-010`), `Shipment`/`OrderRefund` `1:N` y `DomainOutbox` (`ADR-011`).
- `[ ]` **`F3.3` — Bóveda `/admin/integraciones` y Pasarelas Agnósticas (`payments-shipping.prisma` + `packages/integrations`):** wizard MFA sobre `IntegrationCredential` (`AES-256-GCM`, `ADR-006`) y `PaymentProvider` (`PaymentAttempt`/`PaymentTransaction`, `refund()`/`void()`, webhooks firmados idempotentes, Wompi, COD + `BlockedIdentity`, Transferencia MFA y `StoreCredit`).
- `[ ]` **`F3.4` — Logística *Pick & Pack* Asíncrona, Multi-Bulto, Flex, Emails y Puerto DIAN:** `ShippingProvider` (Aveonline asíncrono + **Claim Idempotente** `ADR-012` + `ShipmentPackage[]` multi-bulto + `LocalDeliveryZone` Flex), `EmailProvider` (Resend + Svix monotónico + baja RFC 8058) y `InvoiceProvider` DIAN UBL 2.1 / Nota Crédito.

---

## 3. Handoff para la siguiente sesión

- **Siguiente turno — Implementador (`F3.1`):** partir de `develop` limpio, crear `feat/f3-1-cart-wholesale-coupons-assisted-sale`, construir el 100 % productivo de `F3.1` (migraciones PG 17 + RLS, `CartService`, `WholesaleTier`, `Bundle`, `Coupon` `BigInt` con locks, UI carrito + `/admin` MFA y `/pagar/[token]`), pasar gates, anotar ADR, marcar `[R]` y hacer commit sin abrir PR.
