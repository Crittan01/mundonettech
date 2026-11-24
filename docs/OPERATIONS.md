# Operación — MundoNetTech

> Documento vivo de desarrollo, verificación y despliegue base. Seguridad en [`SECURITY.md`](SECURITY.md); esquema en `packages/db/prisma/schema/*.prisma`.

## 1. Requisitos y arranque local

- Node.js 22, pnpm 11.0.9, GNU Make y Podman rootless con socket de usuario activo.
- No se instalan herramientas globales ni se usan `sudo`, `corepack` global o procesos de otros proyectos.
- Puertos reservados en loopback (`127.0.0.1`): Next `:4010`, E2E `:4110`, Supabase API `:54421`, PostgreSQL `:54422`, Studio `:54423`, Mailpit `:54424`, SMTP/POP3 `:54425/:54426`, PostgreSQL desechable de tests `:54428`.

```bash
pnpm install --frozen-lockfile
make db-start       # servicios, migraciones y apps/web/.env.local si no existe
make db-verify      # PG17, RLS, privilegios y HTTP real
make dev            # http://127.0.0.1:4010
```

`apps/web/.env.local` tiene modo `0600`, se conserva entre reinicios y nunca se versiona. Las claves Turnstile de prueba solo se usan localmente. `make db-stop` detiene únicamente contenedores `_mundonettech` y conserva volúmenes. Un reset de datos local es destructivo y requiere decisión humana explícita; no forma parte de los targets habituales.

## 2. Variables por ambiente

Configura mediante el gestor de secretos correspondiente:

| Variable | Uso |
| --- | --- |
| `DATABASE_URL` | Conexión backend PostgreSQL 17; obligatoria en producción. |
| `NEXT_PUBLIC_SITE_URL` / `SITE_URL` | Origen canónico público para metadata y enlaces server-side de venta asistida, respectivamente; `SITE_URL` se evalúa en runtime y usa HTTPS fuera de loopback. |
| `NEXT_PUBLIC_SUPABASE_URL` / clave publicable | Auth SSR/browser; nunca clave service role. |
| `SUPABASE_SERVICE_ROLE_KEY` | Solo bootstrap/invitaciones/recuperación server-side. |
| `SESSION_TIMEOUT_SECRET` | HMAC de actividad; 32 bytes base64. |
| `SECURITY_EVENT_PEPPER` / `RECOVERY_CODE_PEPPER` | Hashes independientes de eventos y códigos. |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Captcha por ambiente y hostname. |
| `TURNSTILE_EXPECTED_HOSTNAME` | Host esperado fuera de desarrollo; STG debe sobrescribirlo. |
| `TURNSTILE_VERIFY_ENDPOINT` | Solo fixture HTTP loopback para E2E; `release:verify` lo rechaza siempre en STG/PRD. |
| `INTEGRATION_ENVIRONMENT` | Ambiente explícito de la bóveda y pagos (`LOCAL`/`STG`/`PRD`); Vercel lo infiere de forma aislada si no se define. |
| `INTEGRATION_CREDENTIAL_KEYS_*` | Llaveros AES independientes `LOCAL`/`STG`/`PRD`. |
| `BANK_TRANSFER_INSTRUCTIONS` | Instrucciones bancarias públicas verificadas; si falta, transferencia no se ofrece. Nunca inventar datos. |
| `R2_*` / `NEXT_PUBLIC_MEDIA_BASE_URL` | Bucket, endpoint y credenciales de medios por ambiente; origen público HTTPS. |
| `CMS_CRON_SECRET` / `CMS_JOB_ACTOR_ID` | Bearer del scheduler y admin activo con `content:write` para `/api/jobs/cms-publish`. |
| `ORDER_CRON_SECRET` / `CRM_JOB_ACTOR_ID` | Bearer independiente y admin activo con `crm:suppress` para `/api/jobs/orders`: abandono/expiración, reservas y retención CRM. |
| `DOMAIN_WORKER_CRON_SECRET` | Bearer independiente para `/api/jobs/domain-events`: fulfillments, guías, correos, DIAN y conciliaciones sobre outbox. |
| `HEALTH_CRON_SECRET` | Bearer independiente para `/api/jobs/health`: capturas agregadas y alertas de salud, respaldo y DR. |
| `CHANNEL_CRON_SECRET` / `CHANNEL_JOB_ACTOR_ID` | Bearer independiente y admin activo con `integrations:write` para `/api/jobs/channels`: OAuth, ingestión de packs/órdenes/envíos y sincronización ML. |
| `MERCADO_LIBRE_TOKEN_URL` / `MERCADO_LIBRE_API_URL` | Solo fixtures loopback cuando `INTEGRATION_ENVIRONMENT=LOCAL`; STG/PRD usan endpoints oficiales y `release:verify` rechaza estos overrides. |
| `META_CAPI_API_URL` | Base Graph solo para fixture loopback en `LOCAL`; STG/PRD usan el endpoint oficial y `release:verify` rechaza este override. |
| `R2_BACKUP_*` | Endpoint, bucket privado y credenciales separados de medios para respaldos cifrados. |
| `R2_RECOVERY_BUCKETS` | Lista exacta de buckets a inventariar/restaurar; debe incluir medios y respaldo y coincidir con el descubrimiento R2. |
| `BACKUP_GPG_PASSPHRASE` / `BACKUP_GPG_PASSPHRASE_FILE` | Una sola fuente por ambiente; la variante archivo exige archivo regular `0600` o más restrictivo. Nunca se pasa como argumento. |
| `RECOVERY_POSTGRES_RUNNER` | `local` con binarios PG17, `podman` local o `docker` solo en CI; las imágenes usan `postgres:17.12-alpine`. |
| `DR_DATABASE_URL` | Conexión administrativa a PostgreSQL 17 aislado para crear/eliminar bases temporales DR; fuera de loopback debe estar en otro host. |

`EMAIL_SEND_DISABLED=1` y `NODE_ENV=test` son obligatorios para pruebas y nunca se activan en STG/PRD. Tanto las guardas de entorno como el runtime (`@mundonettech/core` y acciones de Auth/Admin) bloquean despachos de correo saliente cuando `EMAIL_SEND_DISABLED=1` está presente, y rechazan hosts remotos (`DATABASE_URL`, `DIRECT_URL`, `NEXT_PUBLIC_SUPABASE_URL`), banderas productivas, llaveros `PRD` y nombres `prd/prod/production/live`. Mailpit es la única bandeja local.

## 3. Migraciones y primer administrador

```bash
pnpm db:validate
pnpm db:migrate     # prisma migrate deploy, cadena única y transaccional
pnpm build
BOOTSTRAP_ADMIN_EMAIL='correo@dominio.co' \
BOOTSTRAP_ADMIN_PASSWORD='contraseña-única-validada' \
BOOTSTRAP_ADMIN_DISPLAY_NAME='Nombre autorizado' \
pnpm admin:bootstrap
```

El bootstrap valida política y HIBP, confirma correo y crea el primer `SUPERADMIN`; el primer login exige TOTP. Vincular una cuenta Auth existente requiere `BOOTSTRAP_ADMIN_LINK_EXISTING=YES` después de verificar propiedad. Las migraciones aplicadas no se editan: cualquier cambio posterior crea una nueva migración. No hay administradores de demostración. `pnpm db:seed` carga explícitamente el catálogo canónico de `config/`, con advisory lock, sin imágenes/GTIN/seriales inventados y sin alterar stock ya existente.

Programa `POST /api/jobs/orders` con `Authorization: Bearer $ORDER_CRON_SECRET` mediante el scheduler del ambiente, sin incluir el secreto en URLs ni logs. El job detecta carritos inactivos, expira carritos vencidos, libera reservas de órdenes `UNPAID` vencidas y expira sus intentos abiertos. Los pagos parciales vencidos generan una revisión deduplicada sin liberar stock ni capturas; los recaudos COD reportados no se cancelan automáticamente. En cada invocación también materializa el `FiscalWatchSnapshot` diario, vence únicamente propuestas B2B actuales expiradas e invalida sus carritos, refresca segmentos activos, inscribe journeys elegibles y despacha mensajes debidos con `dispatchVersion`, ejecuta la retención CRM con el actor `CRM_JOB_ACTOR_ID` (suprime linajes vencidos sin obligaciones y difiere 30 días los bloqueados) y sincroniza notificaciones operativas, sin depender de visitas al backoffice. Emite únicamente eventos `DomainOutbox` sin PII para que los workers posteriores procesen efectos externos. La respuesta es `no-store`, expone solo contadores y el bearer se compara con hash en tiempo constante.

Programa también `POST /api/jobs/domain-events` con `Authorization: Bearer $DOMAIN_WORKER_CRON_SECRET`. El worker reclama únicamente tipos registrados, crea fulfillments y guías multi-bulto, concilia resultados inciertos antes de reintentar, transmite facturas/notas crédito, procesa correos Resend/Svix y encola/despacha Meta CAPI desde `order.payment.paid.v1`/`meta.capi.dispatch.v1`. Usa claims con expiración, backoff y dead letter persistente; nunca incluye PII en el outbox. La credencial Meta se configura desde `/admin/integraciones`; revocar `ADVERTISING` cancela pendientes y los resultados inciertos exigen conciliación MFA en ese panel.

Programa `POST /api/jobs/health` cada cinco minutos con `Authorization: Bearer $HEALTH_CRON_SECRET`. La respuesta `no-store` contiene únicamente fecha, estado y número de alertas. La captura deduplica estados equivalentes, revisiona cambios dentro del minuto y resuelve/reabre `health.*` sin mutar su identidad. `/admin/salud` exige `aal2` + `audit:read` y presenta evidencia sin claves de objetos, hashes ni cadenas de conexión.

Programa `POST /api/jobs/channels` cada cinco minutos con `Authorization: Bearer $CHANNEL_CRON_SECRET` y un actor `CHANNEL_JOB_ACTOR_ID` activo con `integrations:write`. El job expira OAuth y renueva tokens sin reutilizar un `refresh_token` incierto, procesa packs/órdenes/envíos desde el outbox y luego sincroniza publicaciones/stock. Configura en la aplicación MCO el callback `/api/channels/mercado-libre/oauth/callback` y el webhook `/api/webhooks/mercado-libre` bajo `SITE_URL`, con PKCE y notificaciones `orders_v2`, `packs` y `shipments`. La firma usa el `client_secret` cifrado de cada cuenta; no hay secreto de webhook adicional ni modo sin firma en STG/PRD. Las respuestas son `no-store` y exponen solo contadores/códigos cerrados.

### Respaldo cifrado y simulacro DR

Programa `pnpm backup:create` al menos cada 24 horas. El comando exige PG17 y `auth.users`, toma advisory lock por ambiente, descubre y compara el 100 % de buckets y ejecuta `pg_dump` custom → GPG AES-256 (`--passphrase-fd 3`) → R2 multipart explícito de 8 MiB. Nunca acumula el volcado con `Buffer.concat`, no usa `PutObject` como fallback y no imprime passphrase, contraseña, URL ni errores crudos. Verifica tamaño, sube un manifiesto con relaciones/buckets/SHA-256 y solo entonces marca `BackupRun=SUCCEEDED`; los fallos quedan codificados y las evidencias de buckets/terminales no se pueden reescribir.

Programa `pnpm dr:drill` mensualmente. Si la última corrida es exitosa y sigue vigente responde `CURRENT`; un fallo posterior no queda oculto por éxitos anteriores. Selecciona el último respaldo exitoso ≤36 h, valida manifiesto/tamaño/hash y todos los buckets con inventario y lectura, crea una base temporal `mnt_dr_*` en `DR_DATABASE_URL`, descifra por streaming hacia `pg_restore` y compara todas las relaciones `public`/`auth` y migraciones. Elimina la base temporal antes de sellar éxito y calcula el siguiente vencimiento a un mes. `pnpm dr:drill -- --force` fuerza un ejercicio adicional sin alterar el respaldo ni el origen. Una passphrase incorrecta, esquema divergente o bucket ilegible produce `FAILED`, nunca una certificación parcial.

En despliegue usa binarios PG17 (`RECOVERY_POSTGRES_RUNNER=local`). En local, `podman` ejecuta la imagen acotada `postgres:17.12-alpine` con stdin interactivo; CI usa `docker` únicamente con `CI=true`. Los contenedores efímeros tienen nombres propios `*_mundonettech`, contraseñas solo por entorno y limpieza acotada. Configura el scheduler de respaldo/DR en una identidad distinta del runtime web y conserva la passphrase en su gestor de secretos.

La credencial R2 de recuperación necesita `ListBuckets`, `HeadBucket`, `ListObjectsV2`, `GetObject`, `HeadObject` y, solo en el bucket privado, multipart create/upload/complete/abort, `PutObject` para el manifiesto y `DeleteObject` limitado a objetos huérfanos de la misma corrida. No requiere permisos de escritura sobre medios ni acceso público al bucket de respaldos.

Configura `POST /api/webhooks/resend` en el proveedor con su secreto Svix y `GET|POST /email/baja/[token]` como URL `List-Unsubscribe` generada por el sistema. Los documentos aceptados se descargan por `/api/recibos/[token]/documentos/{invoice|credit-note}/[id]`; las operaciones admin usan MFA reciente y RBAC `fulfillment:*`, `communications:*`, `invoices:*`.

## 4. Gates y suites

```bash
make check            # docs/Git/idioma/fronteras/anti-PRD, lint, Prettier y typecheck total (incl. Vitest/E2E)
pnpm test             # Vitest + integración Node sobre PG17 real + matriz RLS/Data API
pnpm test:unit        # contratos Vitest de guardas, catálogo, WAC, seriales, CSV, IVA, Flex, UBL, Meta CAPI y proveedores
pnpm test:integration # catálogo, inventario, checkout, RLS, bóveda, OAuth/User Products, packs/órdenes/ME2/Flex/Full, Meta CAPI, Shipping, Email, DIAN y DR real
pnpm test:rls         # matriz autónoma sobre PG17 real (2.272 denegaciones bajo SAVEPOINT/ROLLBACK)
pnpm build            # build productivo + empaquetado standalone completo
pnpm exec playwright install --with-deps chromium
pnpm test:e2e         # build + servidor standalone 127.0.0.1:4110 + Chromium + axe
pnpm test:owasp       # CSP/aislamiento/auth/CSRF/CORS/límites sobre standalone y PG17
pnpm test:lighthouse  # 4 categorías ≥ 95, móvil/escritorio, home/PLP/PDP/legal
pnpm test:k6          # contención real stock/cupones/checkout/pagos + invariantes PG17
pnpm audit:dependencies # vulnerabilidades altas/críticas en dependencias productivas
```

En local, `pnpm test:integration` y `pnpm test:rls` levantan un contenedor PG 17 desechable (`*_mundonettech` en `:54428`) con contraseña aleatoria si `TEST_DATABASE_URL` no está definida, y lo eliminan al terminar. En CI usan el servicio aislado `TEST_DATABASE_URL`. `scripts/rls-matrix.mjs` verifica cobertura exacta contra `pg_class`, siembra fixtures válidos dentro de una transacción revertida y prueba 2.272 casos reales: 655 operaciones (`SELECT`, `SELECT FOR UPDATE`, `UPDATE`, `DELETE`, `INSERT`) con grants SQL explícitos sobre un rol `NOBYPASSRLS` y 1.617 operaciones sobre `anon`, `authenticated` y `service_role` en las 131 tablas y 15 funciones RPC.

`pnpm test:e2e` crea o reutiliza exclusivamente el PostgreSQL aislado de pruebas, aplica migraciones y seed canónico, y luego arranca el artefacto real `.next/standalone` en `127.0.0.1:4110`. Playwright recorre catálogo/PDP/comparador, carrito, checkout domicilio/Click & Collect/Flex, recibo/descarga, scheduler de órdenes, cupones, bundles, precios, venta asistida, bóveda, OAuth PKCE de Mercado Libre con renovación/reconexión/desvinculación, publicación User Products, precio por fórmula, webhooks firmados de pedidos/envíos, packs ME2/Flex, stock/seriales/ledger y scheduler de canales, Meta Catalog CSV y CAPI con credencial cifrada, dispatch y reconciliación MFA, y ciclo local de alistamiento/empaquetado/despacho/entrega con MFA `aal2`, auth y seguridad, los cuatro paneles operativos, asignación Serial/IMEI, reembolso conciliado, finanzas netas y CSV, cuenta/perfil/direcciones DANE, RMA/garantías/PQR/reseñas con moderación MFA, CRM 360 con duplicados/fusión/reversa/tareas/supresión y retención programada, flujo B2B completo, acceso invitado OTP, referidos y fidelización, segmentos/journeys, analítica RFM/LTV, Centro de Ayuda v2 con búsqueda/filtros/FAQ y `/admin/salud` con scheduler y evidencia de respaldo/DR, RBAC, controles de teclado, CSP/HSTS, `no-store`/`noindex` transaccional y `@axe-core` WCAG A/AA en 70 escenarios. Las ausencias dinámicas se validan con `noindex` según el streaming de Cache Components; el 404 estático conserva su status. `test-results/`, `playwright-report/` y traces no se versionan.

`pnpm test:owasp` repite las cabeceras y rechazos negativos en respuestas exitosas y de error (incluyendo extensiones estáticas, métodos `405`, recibos y bajas RFC 8058). `pnpm test:lighthouse` siembra PG17, fuerza el build standalone sobre esos mismos datos y exige ≥ 95 en rendimiento, accesibilidad, buenas prácticas y SEO para `/`, `/productos`, `/producto/sony-wh-1000xm5` y `/legal`, con perfiles móvil y escritorio; conserva reportes JSON/HTML en `tmp/lighthouse/`. `pnpm test:k6` usa el binario de `PATH`/`K6_BINARY` o la imagen acotada `grafana/k6:1.3.0`, ejecuta 32 reservas multi-variante, 24 canjes, 16 checkouts y 16 pagos en contención, y exige 28 éxitos, 60 rechazos de negocio, cero deadlocks/errores y 76 invariantes persistidas (incluyendo cuadre de recibos y cero PII en `DomainOutbox`); conserva métricas e invariantes en `tmp/k6/`. Estas suites usan los mismos puertos aislados y deben ejecutarse en serie, nunca contra STG/PRD ni en paralelo local.

Las sondas `GET /api/health/live` y `GET /api/health/ready` responden `no-store`, `nosniff` y `noindex`, sin versiones, cadenas de conexión ni detalles internos. `live` confirma el proceso; `ready` exige PostgreSQL 17, migraciones aplicadas sin pasos incompletos o revertidos y el event trigger `enforce_rls_on_new_table` activo, devolviendo 503 ante cualquier falla.

## 5. GitHub Actions PostgreSQL 17

`.github/workflows/ci.yml` corre en PRs contra `develop` y pushes a `develop`, con permisos de solo lectura y cancelación de ejecuciones duplicadas. El job usa `postgres:17.12-alpine` en `:54422`, health checks, secretos HMAC aleatorios y `EMAIL_SEND_DISABLED=1`; no requiere Supabase remoto ni cuentas comerciales. La acción de k6 está fijada por commit y la auditoría de dependencias productivas bloquea vulnerabilidades altas o críticas.

Orden del gate: instalación frozen → auditoría de dependencias → validación/migración → `make check` → `pnpm test` + `verify-security-posture` + `pnpm test:rls` → `pnpm build` standalone → Chromium → `pnpm test:e2e` → `pnpm test:owasp` → `pnpm test:lighthouse` → `pnpm test:k6` → árbol Git limpio. Los diagnósticos Playwright y las evidencias Lighthouse/k6 se cargan como artefactos retenidos siete días.

## 6. Build standalone y ambientes

`pnpm build` genera `apps/web/.next/standalone` con tracing desde la raíz del monorepo y `apps/web/scripts/prepare-standalone.mjs` sincroniza `.next/static/` y `public/` dentro de `apps/web/.next/standalone/apps/web/`, dejando `server.js` listo para ejecutarse con `PORT` y `HOSTNAME`. Variables y migraciones se validan antes de iniciar el proceso; nunca se copia `.env.local` a STG/PRD.

- **LOCAL:** Supabase/Podman y claves de prueba en loopback (`127.0.0.1`).
- **STG:** Preview de `develop`, Supabase STG y secretos independientes; aún por aprovisionar.
- **PRD:** rama `production`, dominio comercial, Supabase PRD/R2; promoción humana, sin acceso desde tests.

Los cambios de esquema se despliegan hacia adelante y se verifican con `db:verify`. Ante una migración fallida, conserva logs y evidencia, detén la promoción y aplica una migración correctiva; no edites el historial aplicado ni uses resets destructivos.

### Checklist STG → PRD y Go-Live

1. **Candidato:** exige el commit completo de `develop` con CI y los cuatro gates de calidad en verde, árbol limpio y reportes del mismo SHA. Despliega ese artefacto en STG con `pnpm db:validate && pnpm db:migrate`, secretos STG independientes y `EMAIL_SEND_DISABLED` ausente.
2. **STG funcional:** carga el catálogo canónico explícitamente si corresponde, crea el administrador real y verifica MFA `aal2`, step-up, RBAC, RLS/Data API, schedulers, webhooks y R2. Ejecuta compras de extremo a extremo con proveedores de prueba, reembolso/posventa, correos y documentos; conserva evidencia sin secretos ni PII.
3. **Aprobaciones STG:** completa identidad legal/NIT/dirección/teléfono, revisión jurídica, buzones, pasarela, logística, Resend, DIAN, Merchant Center, Meta Commerce/Events Manager (`RELEASE_META_VERIFIED`), respaldo y restauración, schedulers y rollback. Son requisitos humanos de `docs/COMPLIANCE.md`, no valores que el código pueda inventar.
4. **Compuerta STG:** exporta la configuración del ambiente y las attestaciones `RELEASE_*` únicamente después de verificar cada evidencia. Ejecuta `RELEASE_ENVIRONMENT=STG RELEASE_TARGET_URL="$STG_URL" pnpm release:verify`; cualquier comprobación fallida detiene la promoción.
5. **Promoción:** abre PR protegido `develop → production`, revisa diff y CI, y obtiene aprobación humana. Prohibido push directo o force-push. Despliega el mismo build, aplica migraciones hacia adelante y configura llaves PRD/Wompi `prod`, R2, Supabase, Turnstile y schedulers sin reutilizar secretos STG.
6. **Go-Live:** verifica DNS/TLS, respaldo y restauración PRD, monitoreo, alertas y rollback. Ejecuta `RELEASE_ENVIRONMENT=PRD RELEASE_TARGET_URL="https://mundonettech.co" pnpm release:verify` con las evidencias STG y `RELEASE_GO_LIVE_APPROVED=YES`. Solo una persona autorizada habilita el tráfico después del resultado exitoso; el comando nunca cambia DNS, ramas, despliegues ni tráfico.
7. **Después:** repite sondas y una compra controlada, observa pagos/outbox/DIAN/correo y conserva evidencia. Para revertir, restaura el artefacto standalone previo y detén la promoción; no edites migraciones aplicadas ni uses resets destructivos, y crea una migración correctiva si el esquema lo requiere.

## 7. Diagnóstico seguro

- **Puerto ocupado:** identifica únicamente contenedores/procesos propios; no uses `pkill` ni limpieza general.
- **Fallo RLS/matrix:** ejecuta `make db-verify` y revisa tabla/operación/rol del caso; toda tabla nueva en `public` debe cubrirse en `scripts/rls-matrix.mjs`.
- **CSP en navegador:** reproduce con `pnpm test:e2e`, conserva trace y corrige el origen/script; no añadas `unsafe-eval` ni `strict-dynamic` sobre shells incompatibles.
- **Correo no recibido:** verifica Mailpit `:54424`; en tests confirma `EMAIL_SEND_DISABLED=1` para impedir proveedores externos.
- **Secretos/compromiso:** rota en el ambiente afectado, cierra sesiones y revisa auditoría. No imprimas URLs con contraseña ni adjuntes `.env` a issues o CI.

## 8. Superficies legales y SEO

- `/legal` y `/legal/[slug]`: ocho documentos validados desde `config/legal.config.ts`; actualizar versión/vigencia y ejecutar build tras cambios.
- `/ayuda` y `/ayuda/[slug]`: nueve guías reales desde `config/help-center.config.ts`, búsqueda sin acentos ≤120 caracteres, filtros, estados vacíos, FAQ y artículos cacheados; el namespace está reservado contra redirecciones y se incluye en sitemap. El proxy valida la allowlist estática sin consultas y reescribe desconocidos a `/_not-found` con status 404 + `noindex` antes de streaming.
- `/robots.txt` y `/sitemap.xml`: recursos públicos cacheados cinco minutos; si hay más de 50.000 URLs, la raíz es un índice hacia `/sitemaps/[id].xml`.
- `/api/feeds/google-merchant`: RSS XML por variante con precio COP, disponibilidad, marca, GTIN/EAN o MPN e imagen real cuando existe. Configurar envío e impuestos en Merchant Center; no se fabrican valores ausentes.
- `/api/feeds/meta-catalog`: CSV por variante con imagen obligatoria, COP/inventario/GTIN/MPN reales y diagnóstico en `/admin/integraciones`. Las mutaciones de catálogo invalidan sus tags; **Actualizar feed** permite refrescarlo manualmente con `integrations:write` + MFA reciente y auditoría `META_CATALOG_FEED_REFRESHED`. CAPI usa el mismo panel para credenciales, estados y conciliación.
- `/admin/contenido/redirecciones`: `content:read` para consulta y `content:write` + MFA reciente para mutaciones. El proxy Node mantiene caché de treinta segundos y las acciones la invalidan al guardar.
- JSON-LD se emite en layout, PDP y FAQs CMS visibles. No añadir ratings, reseñas, GTIN, imágenes o disponibilidad sintéticos para mejorar aparentemente un feed.
