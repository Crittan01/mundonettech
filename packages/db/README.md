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
- `verifySecurityPosture()`: verifica PG 17, ausencia de `BYPASSRLS` en `anon`/`authenticated`, RLS habilitada/forzada en todas las tablas, cero políticas RLS expuestas a `PUBLIC` o Data API, revocación sobre esquema/tablas/vistas/secuencias/funciones, trigger DDL `enforce_rls_on_new_table` (que además revoca privilegios al crear tablas), triggers de inmutabilidad y salud de `_prisma_migrations`.

## Invariantes

- 100 % RLS *deny-by-default* y PostgREST revocado incluso para `service_role`.
- `AdminActionLog` (con detección automática de `selfDealing` por `targetAdminUserId` o `AdminUser`), `SecurityEvent` (deduplicado por minuto UTC) y `Consent` son *append-only*; `AdminRecoveryCode` e `IntegrationCredential` bloquean mutación de identidad o reversión de consumo/revocación por trigger.
- Claves naturales con `deletedAt` usan índices únicos parciales (`ADR-004`) y todo monto monetario usa `BigInt` en centavos COP con `CHECK >= 0` (`ADR-002`), validados por guarda CI.
- `pnpm test:rls`: valida cobertura completa contra `pg_class` y ejecuta 531 casos reales bajo `SAVEPOINT`/`ROLLBACK` (150 con grants SQL sobre rol `NOBYPASSRLS` y 381 sobre `anon`/`authenticated`/`service_role` en las 30 tablas y 7 funciones RPC), con `NODE_ENV=test`, `EMAIL_SEND_DISABLED=1` y URLs anti-PRD obligatorias. Operación completa en `docs/OPERATIONS.md`.
- `catalog.prisma` define 21 entidades de catálogo con GS1, árbol N-niveles, opciones, atributos tipados, compatibilidad, bundles, medios, wishlist/suscripciones, redirects sin ciclos y `tsvector` GIN mantenido por triggers.
