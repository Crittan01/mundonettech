# Operación — MundoNetTech

> Documento vivo de desarrollo, verificación y despliegue base. Seguridad en [`SECURITY.md`](SECURITY.md); esquema en `packages/db/prisma/schema/*.prisma`.

## 1. Requisitos y arranque local

- Node.js 22, pnpm 11.0.9, GNU Make y Podman rootless con socket de usuario activo.
- No se instalan herramientas globales ni se usan `sudo`, `corepack` global o procesos de otros proyectos.
- Puertos reservados: Next `:4010`, E2E `:4110`, Supabase API `:54421`, PostgreSQL `:54422`, Studio `:54423`, Mailpit `:54424`, SMTP/POP3 `:54425/:54426`, PostgreSQL desechable de tests `:54428`.

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
| `NEXT_PUBLIC_SUPABASE_URL` / clave publicable | Auth SSR/browser; nunca clave service role. |
| `SUPABASE_SERVICE_ROLE_KEY` | Solo bootstrap/invitaciones/recuperación server-side. |
| `SESSION_TIMEOUT_SECRET` | HMAC de actividad; 32 bytes base64. |
| `SECURITY_EVENT_PEPPER` / `RECOVERY_CODE_PEPPER` | Hashes independientes de eventos y códigos. |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Captcha por ambiente y hostname. |
| `TURNSTILE_EXPECTED_HOSTNAME` | Host esperado fuera de desarrollo; STG debe sobrescribirlo. |
| `INTEGRATION_CREDENTIAL_KEYS_*` | Llaveros AES independientes `LOCAL`/`STG`/`PRD`. |

`EMAIL_SEND_DISABLED=1` y `NODE_ENV=test` son obligatorios solo para pruebas. Nunca se configuran así en STG/PRD. Las pruebas rechazan hosts remotos, nombres de BD `prod/prd/production`, puertos inesperados y cualquier ejecución sin bloqueo de correo saliente. Mailpit es la única bandeja local.

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

El bootstrap valida política y HIBP, confirma correo y crea el primer `SUPERADMIN`; el primer login exige TOTP. Vincular una cuenta Auth existente requiere `BOOTSTRAP_ADMIN_LINK_EXISTING=YES` después de verificar propiedad. Las migraciones aplicadas no se editan: cualquier cambio posterior crea una nueva migración. No hay seeds comerciales ni administradores de demostración.

## 4. Gates y suites

```bash
make check           # docs/Git/idioma/fronteras/anti-PRD, lint, Prettier y typecheck
pnpm test            # Vitest + Node + PG17 real + matriz RLS
pnpm test:unit       # contratos Vitest de ambiente de pruebas
pnpm test:integration# integración Node y fixtures persistentes
pnpm test:rls        # matriz independiente tras poblar fixtures
pnpm build           # build productivo de todos los paquetes
pnpm exec playwright install chromium
pnpm test:e2e        # build web + servidor :4110 + Chromium + axe
```

La integración local crea `f03-security-test_mundonettech` con contraseña aleatoria y lo elimina al terminar. Si `TEST_DATABASE_URL` está presente (CI), usa ese servicio aislado sin iniciar Podman. La matriz crea un rol `NOBYPASSRLS`, otorga permisos SQL y demuestra 36 denegaciones RLS: `SELECT`, `INSERT`, `UPDATE` y `DELETE` sobre las nueve tablas con filas persistidas.

Playwright ejecuta seis rutas públicas, redirects protegidos, campos accesibles, captura `pageerror`/violaciones CSP y axe WCAG 2/2.1 A/AA. `test-results/`, `playwright-report/` y traces no se versionan.

## 5. GitHub Actions PostgreSQL 17

`.github/workflows/ci.yml` corre en PRs contra `develop` y pushes a `develop`, con permisos de solo lectura y cancelación de ejecuciones duplicadas. El job usa `postgres:17.12-alpine` en `:54422`, health checks, secrets HMAC aleatorios y `EMAIL_SEND_DISABLED=1`; no requiere Supabase remoto ni cuentas comerciales.

Orden del gate: instalación frozen → validación/migración → `make check` → `pnpm test` + `test:rls` → build → Chromium → E2E/axe. Un fallo detiene el pipeline. Las ramas protegidas exigen PR; no se hacen pushes directos ni despliegues desde este workflow.

## 6. Build standalone y ambientes

`pnpm build` genera `apps/web/.next/standalone` con tracing desde la raíz del monorepo. El artefacto desplegado debe incluir además `public/` y `.next/static/` en las ubicaciones documentadas por Next.js, o servirlos desde CDN. Variables y migraciones se validan antes de iniciar el proceso; nunca se copia `.env.local` a STG/PRD.

- **LOCAL:** Supabase/Podman y claves de prueba.
- **STG:** Preview de `develop`, Supabase STG y secretos independientes; aún por aprovisionar.
- **PRD:** rama `production`, dominio comercial, Supabase PRD/R2; promoción humana, sin acceso desde tests.

Los cambios de esquema se despliegan hacia adelante y se verifican con `db:verify`. Ante una migración fallida, conserva logs y evidencia, detén la promoción y aplica una migración correctiva; no edites el historial aplicado ni uses resets destructivos.

## 7. Diagnóstico seguro

- **Puerto ocupado:** identifica únicamente contenedores/procesos propios; no uses `pkill` ni limpieza general.
- **Fallo RLS/matrix:** ejecuta `make db-verify` y revisa tabla/operación del caso; no debilites políticas para hacer pasar tests.
- **CSP en navegador:** reproduce con `pnpm test:e2e`, conserva trace y corrige el origen/script; no añadas `unsafe-eval` ni `strict-dynamic` sobre shells incompatibles.
- **Correo no recibido:** verifica Mailpit `:54424`; en tests confirma `EMAIL_SEND_DISABLED=1` para impedir proveedores externos.
- **Secretos/compromiso:** rota en el ambiente afectado, cierra sesiones y revisa auditoría. No imprimas URLs con contraseña ni adjuntes `.env` a issues o CI.
