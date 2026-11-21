# Arquitectura Técnica e Invariantes de Ingeniería — MundoNetTech (`mundonettech.co`)

> **Documento vivo de Nivel 1.** Define la topología del monorepo, fronteras de paquetes, los 10 contextos acotados de datos y las invariantes obligatorias de seguridad, dinero, inventario, logística, impuestos y rendimiento. El esquema exacto de columnas reside únicamente en `packages/db/prisma/schema/*.prisma` (`ADR-018`).

## 1. Estructura del Monorepo y Frontera de Dominio (`ADR-001`)

```text
mundonettech/
├── apps/
│   └── web/                        # Next.js 16 (App Router, proxy.ts, 'use cache', output: "standalone")
│       ├── app/
│       │   ├── (storefront)/       # Layout único (Header/Footer cacheados + islas <Suspense> de sesión/LiveEdit)
│       │   ├── (auth)/             # Login, registro (HIBP + OTP 6 dígitos + Turnstile), recuperación
│       │   ├── checkout/           # 3 pasos (datos DANE/Click&Collect -> envio -> pago -> gracias)
│       │   ├── mi-cuenta/          # Autoservicio cliente + supresión/anonimización Ley 1581
│       │   ├── pedido/[token]/     # Posventa invitado 2FA + RMA (retracto parcial, cambio, garantía)
│       │   ├── pagar/[token]/      # Link rápido de venta asistida / mostrador
│       │   ├── propuesta/[token]/  # Propuesta B2B versionada y firmada
│       │   ├── admin/              # Login + MFA TOTP aal2 + Shell 8 roles + Vistas limpias (print)
│       │   └── api/                # Webhooks firmados, jobs protegidos, feeds XML y sondas /api/health/*
│       └── components/             # Segregación estricta: ui/, layout/, catalog/, cms/, admin/, orders/
├── config/                         # ÚNICO lugar con marca, dominio, paleta, textos semilla y taxonomía
│   ├── store.config.ts             # Nombre, mundonettech.co, MNT-YYYY-NNNN, régimen fiscal, módulos activos
│   ├── theme.config.ts             # Tokens CSS semánticos Tailwind v4 (preset Tech Precision) y fuentes
│   └── catalog-blueprint.ts        # Categorías tech iniciales, marcas, atributos técnicos y compatibilidad
├── packages/
│   ├── db/                         # Prisma multi-file (BigInt) + cadena única de migraciones + RLS/triggers
│   ├── core/                       # Domain Services puros Cross-Surface (Dinero, IVA, Catálogo, Carrito, Orden, WAC, Outbox, CRM, SLA)
│   ├── media/                      # sharp-safe AVIF/WebP + Cloudflare R2 + Spin 360° + Visor 3D PBR/AR lazy
│   ├── cms/                        # CMS v3 de bloques componibles Zod + interpolación {{tokens}} + Live Edit
│   ├── integrations/               # Bóveda AES-256-GCM + Puertos: PaymentProvider, ShippingProvider, EmailProvider, ChannelProvider (ML MCO, Meta), InvoiceProvider (DIAN), Gemini 0-PII
│   └── legal-co/                   # Paquete legal colombiano parametrizado + consumer-law + colombian-sla
├── supabase/                       # Configuración local Podman (:54421..54424)
├── scripts/                        # Guardas CI (presupuesto Nivel 0, higiene Git, anti-voseo, env-guard, backups R2 streaming, DR drill)
├── docs/                           # Documentación viva en 3 niveles
└── Makefile                        # Interfaz canónica de desarrollo y verificación
```

**Dirección estricta de dependencias:** `apps/web → packages/*` y `apps/web → config/*`. Está prohibido importar desde `@/app/*` hacia `packages/*` o `components/*`, así como quemar strings de marca o slugs literales de productos en reglas de negocio.

---

## 2. Los 10 Contextos Acotados en PostgreSQL 17 (`packages/db/prisma/schema/`)

1. **`crm.prisma` (Identidad y CRM 360):** `Organization` (`priceListId` opcional), `Contact` (separado de `Customer` con 4 niveles de verificación y exclusión de destinatarios de regalo), `ContactIdentity`, `IdentityMergeCandidate` (fusión humana con MFA y snapshot reversible), `Customer` (`CHECK loyaltyPoints >= 0`), `Address` (`countryCode` + DANE DIVIPOLA estructurado), `ContactActivity`, `Task`.
2. **`admin.prisma` (Backoffice, RBAC y Seguridad):** `AdminUser` (8 roles retail: `SUPERADMIN`, `OPERATIONS_MANAGER`, `STORE_MANAGER`, `INVENTORY_BUYER`, `FULFILLMENT`, `CUSTOMER_SUPPORT`, `FINANCE_ANALYST`, `CMS_EDITOR`), `AdminRecoveryCode` (exclusivamente HMAC-SHA256 con pepper de servidor y consumo atómico), `AdminActionLog` (detección automática de `selfDealing`), `SecurityEvent` (deduplicado por minuto con `ipHash`), `Notification` + `NotificationRead` (lectura individual por operador), `IntegrationCredential` (`AES-256-GCM` + `keyVersion`).
3. **`catalog.prisma` (Catálogo Unificado y Vertical Tech):** `Brand` (`/marca/[slug]`), `Category` (árbol N-niveles con `materializedPath` + `externalCategoryMap` para ML/Google), `Collection` + `CollectionProduct`, `Product` (`taxGroupId`, `authenticity`: `ORIGINAL` | `CERTIFIED_COMPATIBLE` | `OEM`, `retractPolicy`, `warrantyMonths`, `trackSerial`), `OptionDefinition` + `OptionValue` (swatches/pills dinámicos), `ProductVariant` (`BigInt` precio y costo propios, `gtin`/`ean` GS1, `mpn`, peso y dimensiones logísticas propias), `ProductMedia` (`IMAGE` | `VIDEO` | `SPIN_360` | `MODEL_3D` | `GAUSSIAN_SPLAT` + `focalX`/`focalY` + `.usdz` AR + hotspots), `AttributeDefinition` + `CategoryAttribute` + `ProductAttributeValue`, `CompatibilityDevice` + `ProductCompatibility`, `Bundle` + `BundleItem`, `WishlistItem`, `BackInStockSubscription` (por `variantId`, re-suscribible tras reposición), `UrlRedirect` (anti-bucles).
4. **`inventory.prisma` (Multi-Bodega, Proveedores y WAC):** `StockLocation` (`LOCAL_MAIN`, `MELI_FULL`, `QUARANTINE`, sedes *Click & Collect*), `StockLevel` (`onHand`, `committed`, `safetyStock`, `weightedAvgCostCents BigInt`), `SerializedUnit` (Serial/IMEI por unidad despachada), `InventoryLedger` (kardex inmutable idempotente con FK formal a `Order`), `Supplier`, `PurchaseOrder`, `PurchaseOrderItem` (recepción atómica recalculando WAC). El CSV de stock es transaccional, idempotente, con seriales JSON y neutralización de fórmulas en exportación (`ADR-025`).
5. **`pricing.prisma` (Precios, Mayorista y Promociones):** `PriceList` + `PriceListItem` (B2B), `WholesaleTier` (precedencia `variante > producto > categoría > global`, sumando unidades entre variantes de un mismo `productId` en carrito), `Coupon` + `CouponProduct`/`CouponCategory` (FKs relacionales reales, `BigInt`, sin techos bajos artificiales), `CouponUsage` (`pg_advisory_xact_lock`), `StoreCreditAccount` / `GiftCard` (`BigInt`).
6. **`orders.prisma` (Carrito, Orden Desacoplada, Impuestos y Outbox):** la raíz `Order` se crea con inventario para sostener la FK de seriales/kardex (`BigInt`, separa `orderStatus`, `paymentStatus` y `fulfillmentStatus`); el checkout completo incorpora `Cart` (FK formal a `Customer`), `CartItem` (revalida precios vigentes al pasar a checkout), `AbandonedCart`, `OrderItem` (congela obligatoriamente `titleSnapshot`, `skuSnapshot`, `unitCostWacCents`, `discountCents` + `OrderItemTaxLine[]`), `OrderReceipt` (comprobante no fiscal obligatorio art. 50 lit. d Ley 1480), `TaxInvoice` + `CreditNote` (puerto UBL 2.1 DIAN), `OrderStatusEvent`, `DomainOutbox`, `IdempotencyKey`.
7. **`payments-shipping.prisma` (Pagos, Envíos Multi-Bulto y Reembolsos):** `PaymentAttempt` + `PaymentTransaction` (agnósticos de pasarela: Wompi, Mercado Pago, Bold, COD, Transferencia MFA, `StoreCredit`, con soporte `refund()`/`void()`), `OrderRefund` (`1:N` parciales/totales de retracto, garantía o ajuste, descontados íntegramente en `/admin/finanzas`), `CodReconciliation` + `RemittanceBatch`, `BlockedIdentity`, `OrderFulfillment` (`1:N` para *split shipments* o *Click & Collect*) + `Shipment` + `ShipmentPackage` (`1:N` bultos reales sin apilado ficticio ni topes bajos) + `ShipmentEvent`, `LocalDeliveryZone` (polígonos/tarifas/corte horario Flex).
8. **`postsale-b2b.prisma` (RMA Unificado, Soporte y B2B):** `ReturnRequest` + `ReturnRequestItem` (admite cantidades parciales por línea, `REFUND` dentro de 5 días hábiles calculados con los 18 festivos oficiales de `colombian-sla.ts`, y `EXCHANGE` para cambios de variante/SKU), `WarrantyClaim` (vinculado a `SerializedUnit` y `OrderRefund`), `SupportTicket` (FK formal `orderId`) + `SupportTicketMessage`, `Review` (FK obligatoria a `OrderItem` entregado), `Opportunity` + `OpportunityProposal` (`BigInt` + `taxCents`) + `OpportunityProposalItem`.
9. **`growth-cms.prisma` (Fidelización, Lifecycle, CMS v3 y Emails):** `LoyaltyTxn` (FK `orderId` + reversa proporcional de puntos `EARN` en reembolso), `Consent` (append-only Ley 1581 con `revokesId`), `LifecycleJourney` + `LifecycleStep` + `LifecycleEnrollment` + `LifecycleMessage`, `StoreSettings` (tabla tipada con RBAC propio, estrictamente separada del CMS editorial), `CmsPage` + `CmsSectionBlock` (bloques tipados Zod reordenables) + `CmsBlockVersion` + `CmsMedia`, `EmailTemplateOverride`, `EmailEvent` (jerarquía monotónica Svix + baja RFC 8058). El CMS F2.1 usa seis bloques estrictos, tokens seguros, historial inmutable, publicación por `effectiveAt`, job autenticado y medios R2 con compensación (`ADR-027`). F2.2 añade `/pagina/[slug]` PPR, renderer de medios/productos, Live Edit `aal2` en `<Suspense>` y SERP/OpenGraph (`ADR-028`).
10. **`channels-obs.prisma` (Omnicanal y Salud Operativa):** `ChannelAccount`, `ChannelListing`, `ChannelOffer` (`FORMULA`/`MANUAL`), `ChannelPack`, `ChannelOrder`, `ChannelShipment`, `ChannelLedgerEntry`, `ChannelSyncJob`, `DailyFunnelMetric` (contadores diarios agregados sin cookies ni PII), `FiscalWatchSnapshot`.

---

## 3. Invariantes Críticas de Ingeniería (Obligatorias en Código y CI)

1. **Dinero y prorrateos sin errores de redondeo:** toda columna monetaria es `BigInt` (`INT8`) en centavos COP con `CHECK >= 0`. Los prorrateos de descuentos/impuestos/reembolsos parciales usan división entera *half-up* sobre `BigInt` (`roundMulDiv`), y toda exportación CSV neutraliza fórmulas (`=+-@\t\r`).
2. **Disponibilidad real y prevención de deadlocks en stock:**
   - El stock vendible siempre resta el colchón de seguridad: `available = max(0, onHand - committed - safetyStock)`.
   - Antes de descontar o revertir múltiples variantes en una transacción, los `variantId` **se ordenan siempre lexicográficamente** para eliminar deadlocks PostgreSQL (`40P01`).
   - Los reintentos de conexión Prisma (`P1001`/`P1017`/`P2024`) jamás duermen ni reintentan operaciones individuales dentro de una transacción interactiva ya abortada; envuelven el inicio completo de la operación.
3. **Soft-Delete sin colisiones `P2002`:** toda entidad con `deletedAt DateTime?` y clave natural (`slug`, `sku`, `code`, `fromPath`, `email`) define índice único parcial SQL `WHERE "deletedAt" IS NULL`.
4. **Un solo servicio de catálogo y búsqueda indexada real:** existe un único `CatalogService` y una única `ProductCard`. Los filtros de precio evalúan los precios efectivos de `ProductVariant`, y el buscador indexa `name`, `Brand`, `SKU`, `GTIN`/`EAN` y `MPN` mediante `tsvector` + `immutable_unaccent` (prohibido `OR similarity(...) > x` que fuerce `Seq Scan`). Los DTO cacheables transportan centavos como strings, la disponibilidad excluye `QUARANTINE`, y admin separa `catalog:read`/`catalog:write` con MFA reciente y auditoría transaccional (`ADR-026`).
5. **Desacoplamiento entre Pago y Despacho (*Pick & Pack*):** el webhook de pago confirma `PAID`, descuenta stock y encola en `DomainOutbox`; la guía de transporte se genera de forma asíncrona o tras alistamiento de bodega bajo un **Claim Idempotente** (índice único parcial sobre envíos en curso) para impedir doble cobro de guías ante timeouts de red.
6. **Seguridad de imágenes y medios en Cloudflare R2 (`$0` egress):** toda imagen entrante pasa por `sharp-safe` (bloqueo de cargadores vulnerables `libvips`, verificación de magic bytes prohibiendo SVG, límite de píxeles e inspección previa de caja `ispe` en HEIC, borrado EXIF/GPS). Los derivados AVIF/WebP, secuencias `SPIN_360` y modelos `MODEL_3D` se sirven desde Cloudflare R2 (`unoptimized: true`), hidratando visores 360°/3D de forma *lazy* para sostener **Lighthouse ≥ 95**.
7. **Caché moderna Next.js 16 y observabilidad limpia:** el storefront usa `(storefront)/layout.tsx` con `'use cache'` + `cacheTag`, aislando lecturas de `cookies()` (sesión y Live Edit) dentro de `<Suspense>` para garantizar Lighthouse ≥ 95. Las páginas CMS viven en `/pagina/[slug]` para conservar el 404 global; sus lecturas públicas y grillas usan DTO/tags cacheables y el preview autenticado queda `noindex` (`ADR-028`). Se prohíbe escribir métricas RUM crudas por visita en PostgreSQL OLTP, mezclar secretos entre STG y PRD, o acumular `pg_dump` en RAM (`Buffer.concat`): los respaldos cifrados GPG (`--passphrase-fd 3`) hacia R2 usan streaming multipart y el DR drill mensual valida frescura (`≤ 36 h`), esquema `auth` y el 100 % de los buckets.
