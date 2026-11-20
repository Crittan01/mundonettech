# Seguridad — MundoNetTech

> Documento vivo del modelo implementado en Fase 0. Las columnas exactas están en `packages/db/prisma/schema/*.prisma`; las decisiones transversales en `DECISIONS.md`.

## 1. Fronteras y modelo de amenazas

La autorización se aplica en servidor en cada página y acción; ocultar navegación nunca concede ni revoca permisos. PostgREST no tiene acceso al esquema `public`, por lo que el navegador solo usa Supabase Auth, nunca tablas de aplicación.

| Amenaza STRIDE / OWASP | Controles implementados |
| --- | --- |
| Suplantación y robo de sesión | Supabase `getUser()`, cookies `httpOnly`/`SameSite=Strict`, TLS/HSTS en producción, timeout HMAC, MFA `aal2` y cierre global con MFA reciente. |
| Manipulación de privilegios | RBAC de 8 roles/3 anillos, bloqueo de automodificación, lock transaccional de membresía y último superadministrador obligatorio. |
| Repudio | `AdminActionLog` inmutable, `selfDealing`, hashes HMAC de IP/User-Agent y metadatos redactados. |
| Divulgación de información | Selects explícitos, PII enmascarada en servidor, RLS forzada, cero secretos en descriptores o logs y CSP con nonce. |
| Denegación de servicio | Turnstile, límites de Supabase Auth, pools y timeouts acotados, paginación, límites de entrada y cierre ante respuestas externas inválidas. |
| Elevación por recuperación | El código HMAC se consume atómicamente; retira factores antiguos y no concede acceso hasta verificar un nuevo TOTP `aal2`. |
| XSS/clickjacking/inyección | CSP `strict-dynamic` + nonce, `frame-ancestors 'none'`, validación Zod, Prisma parametrizado y sin HTML de terceros sin sanitizar. |

## 2. RBAC: ocho roles, tres anillos

- **Anillo 1 — Control:** `SUPERADMIN`, `OPERATIONS_MANAGER`. Gestión de usuarios; solo `SUPERADMIN` administra cuentas del Anillo 1 o asigna cualquier rol.
- **Anillo 2 — Gestión especializada:** `STORE_MANAGER`, `INVENTORY_BUYER`, `FINANCE_ANALYST`. `FINANCE_ANALYST` también consulta auditoría.
- **Anillo 3 — Ejecución:** `FULFILLMENT`, `CUSTOMER_SUPPORT`, `CMS_EDITOR`. Acceden a su resumen y seguridad propia, sin usuarios ni auditoría global.

Un operador no puede cambiar su propio rol/estado. `OPERATIONS_MANAGER` solo asigna/administra Anillos 2 y 3. Las mutaciones usan MFA reciente y registran antes/después sin almacenar PII innecesaria.

## 3. Autenticación de clientes

- Registro: correo + contraseña validada por política y HIBP k-anonymity; Supabase envía OTP de seis dígitos.
- Acceso: OTP de un solo uso con `shouldCreateUser: false`.
- Recuperación: OTP + contraseña nueva nuevamente validada por HIBP.
- Registro, acceso, recuperación y verificación exigen Turnstile. Las solicitudes devienen un mensaje uniforme para impedir enumeración.
- HIBP envía únicamente cinco caracteres del SHA-1, con padding y timeout; una falla impide usar contraseña no verificada.
- Tras verificar OTP se sincroniza `Customer` en PostgreSQL y se emite la cookie de actividad. Un error de persistencia cierra la sesión.

## 4. Administración y MFA obligatorio

1. Correo/contraseña + Turnstile validan la identidad inicial y un `AdminUser` activo.
2. `/admin/login/mfa` exige TOTP enrolado y verificado por desafío de Supabase.
3. Solo después de `currentLevel = aal2` se actualiza `lastSignInAt`, se registra auditoría y se emite la actividad administrativa.
4. El primer enrolamiento genera diez códigos de 80 bits, mostrados una vez; la BD guarda exclusivamente HMAC-SHA256 con pepper.
5. Recuperación: el código se consume una vez, se eliminan factores TOTP anteriores y una cookie HMAC de diez minutos habilita el reset. El panel sigue bloqueado hasta enrolar y verificar otro TOTP; se regeneran todos los códigos.

`requireRecentMfa` consulta AMR de Supabase y exige método OTP durante los últimos diez minutos. Invitaciones, cambios de roles, regeneración de códigos y cierre global lo utilizan. El step-up vuelve a hacer challenge/verify, no acepta solo una cookie.

## 5. Sesiones y borde Next.js 16

`apps/web/proxy.ts` sincroniza cookies de request/response con `@supabase/ssr` y usa `getUser()` para decisiones. Los tokens HMAC incluyen sujeto UUID, tipo, emisión, última actividad, expiración y identificador aleatorio; la firma se compara en tiempo constante.

- Admin: inactividad 30 minutos, renovación deslizante y límite absoluto 12 horas.
- Cliente: 30 días, con el mismo mecanismo de renovación.
- Reset de factor: 10 minutos, tipo y sujeto separados.

Toda respuesta incluye CSP con nonce por solicitud, `nosniff`, `DENY`, Referrer-Policy, Permissions-Policy, COOP/CORP y HSTS fuera de desarrollo. Turnstile queda limitado a `challenges.cloudflare.com`; el contenido dinámico está bajo `<Suspense>` para evitar nonces en HTML estático.

## 6. Datos, PII y auditoría

RLS permanece habilitada y forzada en todas las tablas de aplicación. El backend autoriza antes de cada consulta y selecciona solo columnas necesarias. Correos, teléfonos, nombres e identificadores tienen máscaras específicas; hashes de IP/User-Agent nunca se reversan ni se muestran. Los metadatos de auditoría redactan claves asociadas a correos, teléfonos, tokens, secretos, contraseñas, códigos o credenciales y limitan profundidad/tamaño.

Los cambios de rol adquieren `pg_advisory_xact_lock`; esto serializa decisiones concurrentes y evita perder al último superadministrador activo. La invitación compensa borrando el usuario Auth si falla su persistencia inicial.

## 7. Secretos y ambientes

Cada ambiente configura valores independientes mediante su gestor de secretos:

- `NEXT_PUBLIC_SUPABASE_URL` y clave pública; `SUPABASE_SERVICE_ROLE_KEY` solo en servidor/CLI.
- `DATABASE_URL` con privilegios mínimos para el backend.
- `SESSION_TIMEOUT_SECRET`, `SECURITY_EVENT_PEPPER`, `RECOVERY_CODE_PEPPER`: 32 bytes aleatorios independientes en base64.
- `NEXT_PUBLIC_TURNSTILE_SITE_KEY` y `TURNSTILE_SECRET_KEY` reales por ambiente.
- Llaveros de credenciales externas según `ADR-006`.

`make db-start` crea `apps/web/.env.local` solo si no existe, con claves locales y secretos aleatorios; nunca se versiona. Las claves Turnstile de prueba generadas allí son exclusivamente locales. Para rotar secretos HMAC/pepper, cierra sesiones afectadas y despliega primero el nuevo valor de forma coordinada; no reuses valores entre ambientes.

## 8. Operación y respuesta

```bash
make db-start
pnpm build
BOOTSTRAP_ADMIN_EMAIL='correo@dominio.co' \
BOOTSTRAP_ADMIN_PASSWORD='contraseña-única-validada' \
BOOTSTRAP_ADMIN_DISPLAY_NAME='Nombre autorizado' \
pnpm admin:bootstrap
```

El bootstrap valida política/HIBP, confirma el correo, crea `SUPERADMIN` activo y registra auditoría. Para vincular un usuario Auth existente exige además `BOOTSTRAP_ADMIN_LINK_EXISTING=YES` tras verificar propiedad. No imprime contraseñas.

Ante sospecha de compromiso: suspende la cuenta desde otro administrador autorizado, ejecuta cierre global con MFA reciente, regenera códigos, rota secretos afectados y revisa `SecurityEvent`/`AdminActionLog`. Los eventos son append-only; no se edita evidencia para “limpiar” un incidente.
