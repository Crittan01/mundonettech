# Seguridad — MundoNetTech

> Documento vivo del modelo implementado en Fase 0. Las columnas exactas están en `packages/db/prisma/schema/*.prisma`; las decisiones transversales en `DECISIONS.md`.

## 1. Fronteras y modelo de amenazas

La autorización se aplica en servidor en cada página y acción; ocultar navegación nunca concede ni revoca permisos. PostgREST no tiene acceso al esquema `public` (incluso para `service_role`), por lo que el navegador solo usa Supabase Auth, nunca tablas de aplicación.

| Amenaza STRIDE / OWASP | Controles implementados |
| --- | --- |
| Suplantación y robo de sesión | Supabase `getUser()`, cookies `httpOnly`/`SameSite=Strict`/`__Host-` (expiradas con atributos completos), TLS/HSTS en producción, timeout HMAC, MFA `aal2` y cierre global con MFA reciente. |
| Manipulación de privilegios | RBAC de 8 roles/3 anillos, bloqueo de automodificación, lock transaccional de membresía, último superadministrador obligatorio y baneo/revocación global inmediata en Supabase Auth al suspender una cuenta. |
| Repudio | `AdminActionLog` y `SecurityEvent` inmutables, `selfDealing` automático, hashes HMAC de IP/User-Agent y metadatos redactados (incluyendo `BigInt` y `Date`). |
| Divulgación de información | Selects explícitos, PII enmascarada en servidor, RLS forzada, cero secretos en descriptores o logs y CSP restringida a `'self'`, `challenges.cloudflare.com` y el origen R2 configurado. |
| Denegación de servicio y fuerza bruta | Turnstile en registro, login, recuperación cliente, login admin, invitación y códigos de recuperación admin; límites de Supabase Auth; pools y timeouts SQL acotados (`15 s`); paginación y cierre ante fallas externas. |
| Elevación por recuperación | El código HMAC se consume atómicamente (inmutable por trigger); retira factores antiguos y no concede acceso hasta verificar un nuevo TOTP `aal2`. |
| XSS/clickjacking/inyección | CSP compatible con Partial Prerendering (`ADR-015`), `object-src 'none'`, `frame-ancestors 'none'`, `form-action 'self'`, validación Zod y Prisma parametrizado. |

## 2. RBAC: ocho roles, tres anillos

- **Anillo 1 — Control:** `SUPERADMIN`, `OPERATIONS_MANAGER`. Gestión de usuarios; solo `SUPERADMIN` administra cuentas del Anillo 1 o asigna cualquier rol.
- **Anillo 2 — Gestión especializada:** `STORE_MANAGER`, `INVENTORY_BUYER`, `FINANCE_ANALYST`. `FINANCE_ANALYST` también consulta auditoría.
- **Anillo 3 — Ejecución:** `FULFILLMENT`, `CUSTOMER_SUPPORT`, `CMS_EDITOR`. Acceden a su resumen y seguridad propia, sin usuarios ni auditoría global.

Un operador no puede cambiar su propio rol/estado. `OPERATIONS_MANAGER` solo asigna/administra Anillos 2 y 3. Las mutaciones exigen MFA reciente (`≤ 10 min`), registran antes/después en `AdminActionLog` y, al pasar a `SUSPENDED`, banean y cierran globalmente todas las sesiones del usuario en Supabase Auth.

## 3. Autenticación de clientes

- Registro: correo + contraseña validada por política y HIBP k-anonymity; Supabase envía OTP de seis dígitos.
- Acceso: OTP de un solo uso con `shouldCreateUser: false`.
- Recuperación: OTP + contraseña nueva nuevamente validada por HIBP.
- Registro, acceso, recuperación y verificación exigen Turnstile y devuelven mensajes uniformes anti-enumeración; los fallos de OTP registran `SecurityEvent` deduplicado por minuto.
- HIBP envía únicamente cinco caracteres del SHA-1, con padding y timeout; una falla impide usar contraseña no verificada.
- Tras verificar OTP se sincroniza `Customer` bajo `pg_advisory_xact_lock` (promoviendo sin colisiones `P2002` perfiles `GUEST` previos del mismo correo a `ACTIVE`) y se emite la cookie de actividad.

## 4. Administración y MFA obligatorio (`aal2`)

1. Correo/contraseña + Turnstile validan la identidad inicial y un `AdminUser` activo (registrando `ADMIN_LOGIN_FAILED` en `SecurityEvent` ante rechazo).
2. `/admin/login/mfa` exige TOTP enrolado y verificado por desafío de Supabase.
3. Solo después de `currentLevel = aal2` se actualiza `lastSignInAt`, se registra auditoría y se emite la actividad administrativa.
4. El primer enrolamiento (o cuando quedan 0 códigos vigentes) genera diez códigos de 80 bits mostrados una sola vez; la BD guarda exclusivamente HMAC-SHA256 con pepper.
5. Recuperación: exige Turnstile + código válido; el código se consume una vez, se eliminan factores TOTP anteriores y una cookie HMAC de diez minutos marca el reset. El panel sigue bloqueado hasta enrolar y verificar otro TOTP, regenerando todos los códigos.

`requireRecentMfa` consulta AMR de Supabase y exige OTP/TOTP en los últimos diez minutos (`stepUpAdminAction` disponible en `/admin/seguridad` y en línea en `/admin/usuarios`). Invitaciones, cambios de roles, regeneración de códigos y cierre global de sesiones lo exigen y registran auditoría.

## 5. Sesiones, IP verificada y borde Next.js 16

`apps/web/proxy.ts` sincroniza cookies de request/response sin condiciones de carrera en `@supabase/ssr` y usa `getUser()`. Los tokens HMAC incluyen sujeto UUID, tipo, emisión, última actividad, expiración e identificador aleatorio comparados en tiempo constante:

- Admin: inactividad 30 minutos, renovación deslizante y límite absoluto 12 horas.
- Cliente: 30 días, con el mismo mecanismo de renovación.
- Reset de factor: 10 minutos, tipo y sujeto separados.

El storefront público (`(storefront)`) se prerenderiza estáticamente con `'use cache'` (`ADR-015`), mientras `(auth)`, `/admin` y `/mi-cuenta` aíslan lecturas dinámicas en `<Suspense>`. Por compatibilidad real de hidratación con shells prerenderizados de Next.js 16 (`cacheComponents: true`), la CSP usa `default-src 'self'`, `script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'` y `form-action 'self'`, sin `'strict-dynamic'` sobre scripts estáticos sin nonce. Imágenes y medios solo admiten el origen propio, `data:`/`blob:` según corresponda y el origen R2 configurado; no existe un comodín `https:`. Toda respuesta del proxy, incluidos errores y APIs, aplica HSTS productivo, `nosniff`, `DENY`, aislamiento COOP/CORP/OAC, política de referrer y bloqueo de dominios cruzados heredados.

La IP de cliente se resuelve únicamente en `apps/web/lib/security/request-context.ts` (único adaptador exento en ESLint `foundation/client-ip`), aceptando solo plataforma verificada (`VERCEL=1` o `TRUSTED_PROXY=cloudflare` con `cf-ray`) o loopback local/E2E (`127.0.0.1` / `localhost`).

## 6. Secretos y operación inicial

Cada ambiente define valores independientes en su gestor de secretos (`NEXT_PUBLIC_SUPABASE_URL`, clave publicable, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `SESSION_TIMEOUT_SECRET`, `SECURITY_EVENT_PEPPER`, `RECOVERY_CODE_PEPPER`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` y llaveros `ADR-006`). `make db-start` crea `apps/web/.env.local` solo si no existe.

```bash
make db-start && pnpm build
BOOTSTRAP_ADMIN_EMAIL='correo@dominio.co' \
BOOTSTRAP_ADMIN_PASSWORD='contraseña-única-validada' \
BOOTSTRAP_ADMIN_DISPLAY_NAME='Nombre autorizado' \
pnpm admin:bootstrap
```


## 7. Checkout, recibos y ciclo de vida de órdenes

- La conversión exige el carrito aislado por token/cliente, validación Server Action cerrada, fingerprint de precios/impuestos/entrega y `IdempotencyKey` con hashes de clave, sujeto y request. Una repetición equivalente recupera la misma orden; reutilizar la clave con otro payload se rechaza.
- DANE, contacto, aceptación legal, UVT, régimen, dinero y WAC quedan en snapshots relacionales inmutables. RLS permanece *deny-by-default* en las 117 tablas y los payloads `DomainOutbox` contienen identificadores/importes operativos, nombres de sede permitidos y jamás correo, teléfono, dirección ni notas del cliente.
- `/recibo/[token]` y su descarga usan un token de 256 bits; la BD guarda solo SHA-256. La emisión y cada lectura recalculan hash y cuadre aritmético. El token de reintento se deriva con HMAC de servidor y no se almacena en claro. Las rutas son `noindex`/`no-store` y no se admiten como orígenes de `UrlRedirect`.
- `UNPAID` se presenta siempre como pago pendiente, nunca como cobro confirmado. El comprobante es no fiscal. Reembolsos exigen actor activo autorizado y orden pagada; su request hash, montos, cantidades y transiciones se validan en PostgreSQL.
- `/api/jobs/orders` exige bearer independiente `ORDER_CRON_SECRET`. La expiración libera stock y cupones en una transacción, nunca borra historial y no ejecuta correo ni APIs externas; los workers consumen el outbox con leases y dueños ya verificados por las primitivas de F0.


## 8. Bóveda y libro de pagos

- `/admin/integraciones` exige `aal2` y step-up en cada creación, rotación, recifrado o revocación. Los formularios no devuelven secretos en su estado de error; los descriptores omiten nonce, ciphertext y authTag. El AAD liga UUID, proveedor, cuenta y ambiente, y PRD solo acepta llaves Wompi `prod`.
- `/admin/pagos` separa `payments:read`/`payments:write`; las mutaciones exigen MFA reciente y actor financiero activo. `integrations:write` queda limitado al Anillo 1. Las referencias externas y las conciliaciones manuales escriben `AdminActionLog` sin PII ni secretos.
- Wompi valida propiedades variables, timestamp, ambiente y checksum antes de tocar el libro. Los eventos se deduplican por hash, se ordenan por fecha del proveedor y descartan estados obsoletos; un pago tardío sobre una orden cancelada genera revisión y no mueve stock.
- Los intentos comprometen como máximo el saldo restante bajo lock. Las transiciones, capturas, compensaciones, versiones de crédito y totales de reembolso se validan en PostgreSQL, también bajo requests concurrentes.
- COD usa hashes HMAC de correo/teléfono/documento, nunca el valor en claro. Recaudos y remesas con diferencias permanecen como discrepancia y no se capturan. Los reembolsos externos con resultado incierto no se reintentan: requieren un ID externo verificado con MFA.

## 9. Logística, comunicaciones y facturación electrónica

- Aveonline, Resend y DIAN usan `IntegrationCredential` con AAD por ambiente. Los tokens de conciliación viajan en cuerpo JSON, nunca en query strings; XML y guías solo se aceptan con firma/referencia validada. Claims con lease, request hash y estados inciertos impiden dobles cobros o transmisiones.
- `/admin/{logistica,comunicaciones,facturacion}` separa `fulfillment:*`, `communications:*` e `invoices:*`; toda mutación exige MFA reciente y auditoría transaccional. Correos y documentos de comprador/conductor se enmascaran en servidor. Zonas Flex exigen DANE y polígonos E6 válidos, y su archivado conserva referencias históricas.
- Svix exige HMAC, timestamp y `svix-id` único; la jerarquía nunca retrocede entregas. La baja RFC 8058 no usa cookies, autorización ni redirects y guarda solo hash del token. Supresiones por tema son append-only.
- Facturas y notas crédito sellan emisor/comprador, resolución, montos y UBL. La DIAN solo marca `ACCEPTED` tras XML firmado y CUFE/CUDE coincidente. `DomainOutbox` lleva UUIDs e importes sin PII; el enlace de recibo se deriva con HMAC en servidor y los XML de cliente exigen el mismo token del recibo.

## 10. Operación, finanzas y despacho serializado

- `/admin/hoy` y `/admin/dashboard` exigen `dashboard:read` pero filtran colas y categorías de `Notification` según los permisos efectivos del rol (`orders:read`, `payments:read`, `finance:read`, `audit:read`); `/admin/pedidos` exige `orders:read` y `/admin/finanzas` restringe a `finance:read` (`403` ante rol autenticado no autorizado en exportación). Toda mutación financiera o logística exige MFA reciente y auditoría. Las vistas enmascaran PII en el DAL y la exportación financiera usa `no-store`, `nosniff`, `noindex` y neutralización de fórmulas CSV.
- `DailyFunnelMetric` contiene solo contadores diarios monotónicos, sin cookies, IP en PostgreSQL ni eventos individuales; el endpoint público valida `Origin`/`Host`, `Content-Type`, tamaño y aplica cuotas en memoria por `ipHash` antes de leer el cuerpo. `Notification` deduplica por clave y `NotificationRead` es append-only por operador autorizado. `FiscalWatchSnapshot` conserva historia diaria inmutable y alertas preventivas/críticas sin cambiar automáticamente el régimen tributario.
- `SerializedUnit.shipmentId` solo admite asignación sobre envíos pre-despacho (`PENDING`/`READY`) de unidades `SOLD` de la misma orden, bodega y variante; locks ordenados serializan las asignaciones y triggers verifican cobertura exacta al despachar e impiden cancelar envíos con seriales asignados. Después de `SHIPPED`, `shipmentId` es inmutable incluso con acceso directo a PostgreSQL, admitiendo solo transición de estado a `RETURNED` en posventa.


## 11. Cuenta, invitados y posventa

- `/mi-cuenta/*` vuelve a validar sesión HMAC y `Customer` activo en cada lectura/mutación. Direcciones DANE, perfil y consentimientos (`revokedBy IS NULL`) se escriben con locks y control optimista; la anonimización exige haber entregado/cerrado órdenes, cobros, reembolsos y RMA activos además de cualquier saldo de crédito a favor (registrando `FORFEIT` sobre puntos vigentes), borra identificadores directos (incluidos `EmailEvent` con o sin `orderId`), revoca sesiones y redirige a `/ingresar?reason=anonymized` conservando solo historia financiera obligatoria.
- `/pedido/[token]` usa un token de recibo solo como primer factor. El OTP de seis dígitos se genera con CSPRNG, se almacena únicamente como HMAC, expira a diez minutos, admite cinco intentos y tiene cuotas por pedido/IP y enfriamiento. La sesión aleatoria se guarda como SHA-256 sobre reloj autoritativo de PostgreSQL, dura treinta minutos, queda ligada al pedido y solo se rota al verificar un OTP válido (impidiendo DoS por solicitud no autenticada), al cerrar o al anonimizar. El correo OTP no tiene cabecera de baja ni se persiste en `EmailEvent`.
- RMA y garantías validan propiedad, entrega por `ShipmentItem`, cantidades acumuladas y seriales por envío bajo locks. `PostSaleAdminService` separa `queue()` y `reviewQueue()`, exige operador activo con permiso de escritura y MFA reciente en la acción web; la aprobación financiera crea `OrderRefund` en la misma transacción, la cancelación desde `/admin/posventa` cancela atómicamente el reembolso no ejecutado (bloqueando cancelación directa huérfana desde `/admin/pedidos`) y el cierre exige `COMPLETED`. Reseñas y PQR aplican propiedad, alertas operativas por rol en `/admin/hoy`, moderación RBAC, auditoría y mensajes inmutables.
- `postsale:*` y `reviews:*` separan lectura/escritura. Finanzas conserva su autorización propia para crear reembolsos. Las diez tablas nuevas mantienen RLS forzada sin políticas, Data API revocada, constraints y triggers de estado; la postura total es 117 tablas y 2.034 denegaciones reales.

## 12. CRM 360 y retención Hábeas Data

- `/admin/crm` separa `crm:read`/`crm:write` de `crm:merge`/`crm:suppress`; fusión, reversa y supresión exigen Anillo 1 y MFA reciente, mientras `/admin/hoy` aísla alertas `crm.tasks` (`crm:read`) y `crm.merges` (`crm:merge`). Los DTO enmascaran nombre, correo, teléfono y documento también en RSC, nunca exponen snapshots, conservan NIT enmascarado salvo reemplazo o limpieza explícita y toda mutación escribe `AdminActionLog` sin PII.
- Las candidatas evalúan motivos exactos por par canónico y usan locks + versiones de candidata/contacto (más validación de organizaciones activas al revertir); una mutación posterior bloquea fusión o reversa. Las seis tablas CRM mantienen RLS forzada sin políticas, Data API revocada y triggers de transición/inmutabilidad. La postura total es 117 tablas y 2.034 denegaciones reales.
- La supresión es bidireccional: tanto `/admin/crm` como la baja self-service de `/mi-cuenta` recorren el linaje completo en la misma transacción, anonimizan `Customer` y `Contact`, eliminan identidades directas y redactan actividades, tareas y snapshots. El scheduler valida siempre `CRM_JOB_ACTOR_ID` activo con `crm:suppress`, difiere obligaciones o PQR abiertas durante 30 días y responde solo contadores.

## 13. Canal B2B y Copiloto 0-PII

- `/empresas` exige Turnstile y consentimiento antes de crear oportunidad, organización y contacto con idempotencia persistente y alerta 0-PII en `/admin/hoy` (`b2b:read`). `/admin/b2b` separa `b2b:read`/`b2b:write`; toda mutación exige MFA reciente, actor activo y auditoría antes de tocar la bóveda o mutar estado, con control optimista de versiones. Las listas solo se editan en borrador y su activación valida vendibilidad completa y techo de catálogo congelando los ítems.
- Cada propuesta sella ítems, dinero `BigInt`, régimen/UVT, impuestos y flete. El enlace usa 256 bits solo como SHA-256, `connection()`, `noindex`/`no-store` y máscara PII server-side en HTML/RSC; reemplazar/cancelar/expirar invalida el carrito `B2B` (excluido de `AbandonedCart`) sin mutar versiones vigentes posteriores bajo jerarquía única de locks (`b2b-opportunity`). La aceptación toma contacto y NIT desde servidor, exige firma/documento/DANE y convierte con el mismo checkout transaccional de stock/WAC/recibo.
- Gemini recibe únicamente estados y agregados numéricos, jamás IDs, PII, notas o requisitos. Su credencial vive en la bóveda por ambiente y la salida se limita a prioridad/acción/motivos/confianza enumerados, sin texto libre ni cambios automáticos. Fusión/reversa conserva oportunidades y la supresión bidireccional (`/admin/crm` y `/mi-cuenta`) bloquea oportunidades abiertas, limpia `movedOpportunityIds`, redacta texto/firma y mantiene importes/historia. Las seis tablas nuevas tienen RLS forzada sin políticas y Data API revocada.

## 14. Lealtad, referidos y recuperación

- `LoyaltyTxn` es append-only y vincula pedido, reembolso (`OrderRefund`) o anulación (`PaymentTransaction` `VOID`) y referido con saldo no negativo. La captura total otorga puntos dentro de la transacción; cada reembolso completado o anulación capturada revierte el acumulado *half-up* con claves idempotentes sin bloquear compensaciones si una contraparte ya fue anonimizada (`FORFEIT`). `ReferralCode` y `Referral` bloquean autorreferidos, cuentas inactivas y segundas compras; `/referido/[code]` usa cookie temporal `__Host-mnt_referral` expirada con atributos completos y los locks de crédito/cliente evitan ciclos entre capturas, ajustes y anonimización.
- La recuperación transporta solo UUIDs y actividad en `DomainOutbox`, actualiza titularidad al autenticar carritos invitados, valida consentimiento y supresión al encolar y antes de Resend, y registra resultados por actividad sin duplicar recordatorios. `/admin/fidelizacion` exige `aal2` + `crm:read` y enmascara correos; `/mi-cuenta/beneficios` exige sesión de cliente activa. Anonimizar registra `FORFEIT`, desactiva códigos y atribuciones pendientes y suprime correos sin borrar historia. Las tres tablas nuevas mantienen RLS forzada sin políticas y Data API revocada (117 tablas y 2.034 denegaciones reales).

## 15. Lifecycle, segmentos y analítica RFM/LTV

- `/admin/{segmentos,lifecycle}` exige `aal2` + `crm:read`; crear, editar borradores, activar, pausar, archivar y evaluar exige `crm:write` + MFA reciente y auditoría transaccional. `/admin/analitica-rfm` exige `finance:read`. Los DTO enmascaran correos y las activaciones sellan definición/pasos con control optimista; las seis tablas nuevas mantienen RLS forzada sin políticas y Data API revocada (117 tablas y 2.034 denegaciones reales).
- `CustomerSegmentMembership` es append-only y conserva consentimiento, versión, hash y métricas sin PII directa. Cada inscripción es única por journey/cliente, cada reclamo incrementa `dispatchVersion` y el outbox transporta solo UUIDs. Consentimiento, membresía y supresión se revalidan al encolar y antes de Resend; baja, revocación, rebote, salida de segmento, archivado y anonimización cancelan trabajo pendiente. Completar exige aceptación real de todos los correos, no solo su creación en cola.
- RFM/LTV usa recencia de capturas, frecuencia pagada y valores `BigInt` netos de anulaciones/reembolsos completados. El mismo CTE alimenta segmentos y analítica, con validación de paridad SQL/dominio, cursor acotado y cero importes `INT4` o floats monetarios.

## 16. Verificación de lanzamiento

- `pnpm test:owasp` valida CSP, aislamiento, HSTS, cobertura total de `proxy.ts` (incluyendo rutas con extensiones de archivo), authn/`405` de jobs/webhooks, CSRF/CORS, bajas RFC 8058 y límites de entrada sobre el standalone y PostgreSQL reales, incluyendo respuestas 401/403/404/405/413/415. Playwright comprueba todas las superficies privadas, exportaciones/XML administrativos con RBAC negativo y defensa en profundidad de `UrlRedirect`, mientras axe exige cero violaciones WCAG 2.1 A/AA; la matriz RLS y las pruebas RBAC/step-up continúan como gates independientes.
- `pnpm audit:dependencies` bloquea vulnerabilidades productivas altas/críticas. El override puntual `@prisma/config>effect=3.22.1` corrige GHSA-7589-6fvf-x4pw sin elevar Prisma ni excluir el aviso.
- `release:verify` exige `NODE_ENV=production`, correo habilitado, adaptador verificado de IP (`VERCEL=1` o `TRUSTED_PROXY=cloudflare`), HTTPS, aislamiento de hosts/buckets/llaveros por ambiente, coherencia de overrides server-side, Turnstile real, R2, schedulers autenticados, salud PG17 (migraciones aplicadas + trigger `enforce_rls_on_new_table`) y attestaciones humanas; no imprime secretos, no ejecuta carga contra ambientes remotos y no promueve código. PRD permanece bloqueado mientras falte cualquier aprobación legal, operativa, de calidad STG o Go-Live.


## 17. Salud, respaldos y recuperación

- `/admin/salud` exige `aal2` + `audit:read` y no expone claves de objetos, hashes, URLs ni credenciales. `/api/jobs/health` exige `HEALTH_CRON_SECRET` independiente y persiste únicamente contadores agregados; `health.*` se filtra con el mismo permiso en `/admin/hoy`. Las capturas equivalentes se deduplican y las alertas conservan identidad estable, resolución y reapertura sin alterar historia.
- `pnpm backup:create` exige PostgreSQL 17 y `auth.users`, bucket privado separado del bucket público, credenciales independientes y descubrimiento exacto de todos los buckets. La passphrase llega solo al descriptor `3` de GPG; el volcado viaja por streams multipart de 8 MiB, sin `Buffer.concat` ni secretos en argumentos/logs. Manifiesto, tamaño y SHA-256 se validan antes de sellar evidencia terminal inmutable.
- `pnpm dr:drill` rechaza respaldos >36 h, manifiestos inconsistentes, hashes divergentes y cobertura incompleta. Restaura con `pg_restore` en una base temporal creada con nombre aleatorio, nunca en `DATABASE_URL`; fuera de loopback exige otro host, compara todas las relaciones `public`/`auth`, verifica inventario/lectura del 100 % de buckets y elimina la base antes de certificar. Passphrases incorrectas y fallos parciales quedan como corridas `FAILED`, sin certificar éxitos anteriores.
- `BackupRun`, `DisasterRecoveryDrill`, `RecoveryBucketCheck` y `OperationalHealthSnapshot` mantienen RLS forzada sin políticas y Data API revocada. `release:verify` exige passphrase, buckets/credenciales separados y DR aislado antes de cualquier promoción.

## 18. OAuth y cuentas Mercado Libre

- `/admin/canales` exige `aal2` + `integrations:read`; iniciar OAuth, reconectar, renovar o desvincular exige `integrations:write`, step-up MFA y actor activo, también dentro del servicio de dominio. `ChannelOAuthAttempt` guarda únicamente SHA-256 del estado, expira a diez minutos y tiene transiciones terminales irreversibles (revocando de inmediato la credencial pendiente si el operador iniciador es suspendido); la cookie `HttpOnly` `SameSite=Lax` (`__Secure-mnt_channel_oauth` en HTTPS, conforme a RFC 6265bis con `Path` de subruta) se limita al callback y al ambiente, y PKCE usa exclusivamente `S256`.
- `client_secret`, verifier, access/refresh tokens se cifran en `IntegrationCredential` con AAD por ambiente, y triggers diferidos en PostgreSQL impiden revocar o rotar desde la bóveda general una credencial ligada a una cuenta activa o a un intento OAuth en curso. El intercambio valida redirect URI fija, alcance `offline_access read write` (más scopes granulares `urn:ml:*` canónicos), vendedor y respuesta acotada; secretos y códigos nunca aparecen en descriptores, logs o URLs propias posteriores. El callback rechaza `HEAD`/`POST` (`405`), responde `no-store`, `noindex` y `Referrer-Policy: no-referrer`, y todo replay queda bloqueado sin nueva llamada externa.
- La renovación serializa por reclamo UUID persistente sin mantener locks durante HTTP. Un reclamo vencido, respuesta inválida, grant rechazado o transporte incierto bloquea la cuenta (`REAUTH_REQUIRED`), revoca la credencial sin reutilizar el `refresh_token` y emite alerta `channels.reauth` (`CRITICAL`) en `/admin/hoy` filtrada por `integrations:read`; reconectar exige una nueva autorización, reemplaza la credencial atómicamente y resuelve la alerta. `/api/jobs/channels` exige `CHANNEL_CRON_SECRET` y `CHANNEL_JOB_ACTOR_ID` con `integrations:write`.
- Desvincular bloquea carreras con renovaciones o autorizaciones en curso, cancela intentos pendientes, revoca localmente incluso si la revocación remota es incierta y conserva ese resultado sin declararla exitosa. Las dos tablas mantienen RLS forzada sin políticas y Data API revocada; la postura actual es 123 tablas y 2.136 denegaciones reales.
