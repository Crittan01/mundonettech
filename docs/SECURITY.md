# Seguridad — MundoNetTech

> Documento vivo del modelo implementado en Fase 0. Las columnas exactas están en `packages/db/prisma/schema/*.prisma`; las decisiones transversales en `DECISIONS.md`.

## 1. Fronteras y modelo de amenazas

La autorización se aplica en servidor en cada página y acción; ocultar navegación nunca concede ni revoca permisos. PostgREST no tiene acceso al esquema `public` (incluso para `service_role`), por lo que el navegador solo usa Supabase Auth, nunca tablas de aplicación.

| Amenaza STRIDE / OWASP | Controles implementados |
| --- | --- |
| Suplantación y robo de sesión | Supabase `getUser()`, cookies `httpOnly`/`SameSite=Strict`/`__Host-` (expiradas con atributos completos), TLS/HSTS en producción, timeout HMAC, MFA `aal2` y cierre global con MFA reciente. |
| Manipulación de privilegios | RBAC de 8 roles/3 anillos, bloqueo de automodificación, lock transaccional de membresía, último superadministrador obligatorio y baneo/revocación global inmediata en Supabase Auth al suspender una cuenta. |
| Repudio | `AdminActionLog` y `SecurityEvent` inmutables, `selfDealing` automático, hashes HMAC de IP/User-Agent y metadatos redactados (incluyendo `BigInt` y `Date`). |
| Divulgación de información | Selects explícitos, PII enmascarada en servidor, RLS forzada, cero secretos en descriptores o logs y CSP restringida a `'self'` y `challenges.cloudflare.com`. |
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

El storefront público (`(storefront)`) se prerenderiza estáticamente con `'use cache'` (`ADR-015`), mientras `(auth)`, `/admin` y `/mi-cuenta` aíslan lecturas dinámicas en `<Suspense>`. Por compatibilidad real de hidratación con shells prerenderizados de Next.js 16 (`cacheComponents: true`), la CSP bloquea orígenes externos (`default-src 'self'`, `script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`) sin incluir `'strict-dynamic'` sobre scripts estáticos sin nonce.

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
- DANE, contacto, aceptación legal, UVT, régimen, dinero y WAC quedan en snapshots relacionales inmutables. RLS permanece *deny-by-default* en las 63 tablas y los payloads `DomainOutbox` contienen identificadores/importes operativos, nombres de sede permitidos y jamás correo, teléfono, dirección ni notas del cliente.
- `/recibo/[token]` y su descarga usan un token de 256 bits; la BD guarda solo SHA-256. La emisión y cada lectura recalculan hash y cuadre aritmético. El token de reintento se deriva con HMAC de servidor y no se almacena en claro. Las rutas son `noindex`/`no-store` y no se admiten como orígenes de `UrlRedirect`.
- `UNPAID` se presenta siempre como pago pendiente, nunca como cobro confirmado. El comprobante es no fiscal. Reembolsos exigen actor activo autorizado y orden pagada; su request hash, montos, cantidades y transiciones se validan en PostgreSQL.
- `/api/jobs/orders` exige bearer independiente `ORDER_CRON_SECRET`. La expiración libera stock y cupones en una transacción, nunca borra historial y no ejecuta correo ni APIs externas; los workers consumen el outbox con leases y dueños ya verificados por las primitivas de F0.
