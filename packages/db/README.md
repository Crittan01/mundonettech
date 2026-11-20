# `@mundonettech/db`

Fuente única del esquema PostgreSQL 17 y cliente Prisma 7 ESM con adaptador `pg`. Los archivos `prisma/schema/*.prisma` definen los modelos base; `prisma/migrations/` contiene la única cadena DDL versionada, incluidos `CHECK`, índices parciales, funciones, triggers y RLS.

## Operación

```bash
make db-start       # Supabase local + prisma migrate deploy
make db-validate    # valida el esquema multi-file
make db-verify      # compila y verifica PG17, RLS, privilegios y migraciones
make db-stop        # conserva los datos locales
```

`createDatabaseClient()` exige una URL PostgreSQL válida, limita el pool y cierra el pool propio al ejecutar `$disconnect()`. `verifySecurityPosture()` comprueba las nueve tablas, RLS habilitada/forzada, revocación de `anon`/`authenticated`/`service_role` y `PUBLIC`, trigger de tablas nuevas, restricciones, índices y salud de migraciones.

## Invariantes

- No hay políticas de lectura pública: toda tabla de aplicación es *deny-by-default*, incluso para su propietario no privilegiado. El acceso de backend se mantiene separado de PostgREST.
- `AdminActionLog`, `SecurityEvent` y `Consent` son *append-only*. Los códigos de recuperación almacenan 32 bytes HMAC y se consumen atómicamente.
- `DomainOutbox` usa `FOR UPDATE SKIP LOCKED`, arrendamiento con expiración y reintentos acotados. `IdempotencyKey` almacena solo hashes, valida sujeto/payload y serializa adquisiciones concurrentes.
- Las identidades naturales con borrado lógico usan índices únicos parciales. Los importes futuros deben declararse `BigInt` en centavos COP y contar con `CHECK >= 0`.

`pnpm test` aplica esta cadena sobre PostgreSQL 17 real en un contenedor desechable y ejecuta pruebas positivas, negativas y de concurrencia. Las migraciones ya aplicadas no se editan; los cambios posteriores crean una nueva migración en la misma cadena.
