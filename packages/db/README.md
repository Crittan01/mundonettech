# `@mundonettech/db`

Fuente única del esquema PostgreSQL 17 y cliente Prisma 7 ESM con adaptador `pg`. Los archivos `prisma/schema/*.prisma` definen los modelos; `prisma/migrations/` contiene la única cadena DDL versionada (`CHECK`, índices únicos parciales, funciones, triggers y RLS).

## Operación y primitivas exportadas

```bash
make db-start       # Supabase local + prisma migrate deploy
make db-validate    # valida el esquema multi-file
make db-verify      # compila y verifica PG17, RLS, políticas, privilegios, triggers y HTTP PostgREST
make db-stop        # detiene solo contenedores _mundonettech conservando el volumen
```

- `createDatabaseClient()`: valida URL PostgreSQL, acota el pool, aplica `statement_timeout` e `idle_in_transaction_session_timeout` (15 s por defecto) y libera el pool en `$disconnect()`.
- Primitivas atómicas compatibles con `PrismaClient` y `Prisma.TransactionClient` (usando `CURRENT_TIMESTAMP` autoritativo de PostgreSQL por defecto para evitar desfase de reloj frente al proceso Node): `consumeAdminRecoveryCode`, `claimDomainOutbox`, `completeDomainOutbox`, `retryDomainOutbox`, `acquireIdempotencyKey` (retorna `acquired: boolean` para distinguir al ganador de carrera frente a duplicados concurrentes o replays), `completeIdempotencyKey` y `purgeExpiredIdempotencyKeys`.
- Inventario: `reserveStock`, `releaseStock`, `fulfillStock`, `transferStock` (con selección explícita opcional de `serials` y transición `IN_STOCK` ↔ `QUARANTINED`) y `getStockAvailability` calculan disponibilidad con `safetyStock`, ordenan locks de forma determinista e independiente del *locale*, serializan mediante advisory locks y escriben un kardex idempotente canónico. Los reintentos de conexión/serialización envuelven la transacción completa.
- Compras: `createPurchaseOrder`, `markPurchaseOrderOrdered`, `cancelPurchaseOrder` y `receivePurchaseOrder` validan estados, entidades activas, cantidades restantes, reloj autoritativo de PG y seriales/IMEI únicos globalmente. Cada recepción parcial recalcula WAC con `BigInt`, persiste unidades y kardex, y cierra automáticamente la orden al completarla.
- CSV: `importInventoryStockCsv` aplica todo el archivo en una transacción, con columnas `locationCode`, `sku`, `onHand`, `safetyStock`, `unitCostCents` y `serials` opcional (JSON de `{serial, imei}`), registrando `OPENING` en el primer asiento y `ADJUSTMENT` en ajustes posteriores. Las aperturas serializadas exigen una identidad por unidad; los conteos posteriores de variantes serializadas se reciben por compras. `exportInventoryStockCsv` neutraliza fórmulas y usa el mismo contrato.
- `CatalogService`: único punto de búsqueda pública, facetas, PDP, comparador, precios efectivos y disponibilidad real; también concentra lista/edición admin y mutaciones con auditoría transaccional. Los DTO cacheables usan strings para centavos y la migración F1.4 añade índices para precio activo y facetas normalizadas.
- `verifySecurityPosture()`: verifica PG 17, ausencia de `BYPASSRLS` en `anon`/`authenticated`, RLS habilitada/forzada en las 38 tablas, cero políticas RLS expuestas a `PUBLIC` o Data API, revocación sobre esquema/tablas/vistas/secuencias/funciones, event triggers DDL `enforce_rls_on_new_table` y `revoke_postgrest_on_new_function`, triggers de seguridad/catálogo/inventario/búsqueda, `CHECK` monetarios/UVT, índices únicos parciales + GIN `Product_searchVector_idx` + índices de catálogo F1.4 y salud de `_prisma_migrations`.

## Invariantes

- 100 % RLS *deny-by-default* y PostgREST revocado incluso para `service_role`.
- `AdminActionLog` (con detección automática de `selfDealing` por `targetAdminUserId` o `AdminUser`), `SecurityEvent` (deduplicado por minuto UTC), `Consent` e `InventoryLedger` son *append-only*; `AdminRecoveryCode` e `IntegrationCredential` bloquean mutación de identidad o reversión de consumo/revocación por trigger.
- Claves naturales con `deletedAt` (y suscripciones activas de reposición) usan índices únicos parciales (`ADR-004`) y todo monto monetario usa `BigInt` en centavos COP con `CHECK >= 0` (`ADR-002`), validados por guarda CI.
- `pnpm test:rls`: valida cobertura completa contra `pg_class` y ejecuta 685 casos reales bajo `SAVEPOINT`/`ROLLBACK` (190 con grants SQL sobre rol `NOBYPASSRLS` y 495 sobre `anon`/`authenticated`/`service_role` en las 38 tablas y 13 funciones RPC), con `NODE_ENV=test`, `EMAIL_SEND_DISABLED=1` y URLs anti-PRD obligatorias. Operación completa en `docs/OPERATIONS.md`.
- `catalog.prisma`: 21 entidades de catálogo (`TaxGroup` con tratamiento IVA/UVT tech `ADR-009`, `Brand`, árbol `Category` N-niveles, `Collection`, `Product` con `tsvector` GIN + `immutable_unaccent` incluyendo atributos `searchable`, `OptionDefinition`/`OptionValue`, `ProductVariant` `BigInt` + GS1/EAN-8/13, `ProductMedia` con FK compuesta `(variantId, productId)`, `frames` validados `2..120` para `SPIN_360`, claves seguras sin traversal e índices únicos parciales sobre `storageKey`, `posterKey` y `usdzKey`, `AttributeDefinition`/`ProductAttributeValue` normalizados y anti-XSS, `CompatibilityDevice`, `Bundle`, `WishlistItem`, `BackInStockSubscription` re-suscribible preservando historial Ley 1581 y `UrlRedirect` anti-ciclos/anti-traversal ≤ 100 saltos).
- `inventory.prisma`: siete entidades de inventario más la raíz `Order` para la FK formal de despacho; `StockLevel` exige saldos no negativos y `committed <= onHand`, `SerializedUnit` garantiza unicidad global de `imei` y coherencia con `QUARANTINE`, `InventoryLedger` valida en PG 17 sus saldos y el conteo exacto de unidades serializadas, y triggers impiden archivar bodegas/proveedores/productos/variantes con stock u órdenes abiertas o conmutar `trackSerial` con inventario existente.
