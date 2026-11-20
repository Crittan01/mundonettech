# AGENTS.md — Reglas Canónicas (Cualquier Asistente de IA)

> **Única entrada canónica para asistentes de IA.** Compacto por diseño para proteger la ventana de contexto.

## 1. Divulgación progresiva obligatoria (3 niveles)

1. **Nivel 0 — Leer SIEMPRE al iniciar sesión (tope CI ≤ 13 KB totales):**
   - Este `AGENTS.md` (≤ 120 lín.) · [`docs/STATE.md`](docs/STATE.md) (≤ 120 lín.) · [`docs/PLAN.md`](docs/PLAN.md) (≤ 160 lín.)
2. **Nivel 1 — Leer SOLO lo que tu tarea toque** (mapa en [`docs/INDEX.md`](docs/INDEX.md)):
   - Arquitectura, paquetes, invariantes de dominio y modelo de datos → [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
   - Decisiones técnicas cerradas (`ADR-XXX`) → [`docs/DECISIONS.md`](docs/DECISIONS.md)
3. **Nivel 2 — Co-localizado:** lee únicamente el `README.md` del paquete (`packages/<pkg>/README.md`) que modifiques. **Jamás cargues el repositorio entero.**

## 2. Mandatos no negociables

1. **Calidad 100 % productiva y modularidad limpia (`ADR-001`):** e-commerce retail y mayorista de tecnología y accesorios multimarca (`mundonettech.co`). Cero prototipos desechables. Toda identidad visual, marca, dominio y reglas específicas del comercio residen aisladas en `config/`, mientras los dominios viven desacoplados en `packages/*` sin strings de marca quemados.
2. **Stack estricto:** Next.js **16** (`proxy.ts`, APIs dinámicas async, `'use cache'`, `output: "standalone"` — revisa `apps/web/node_modules/next/dist/docs/` antes de tocar APIs del framework) + React 19 + TS strict (`noUncheckedIndexedAccess`, cero `any`) + Tailwind v4 (tokens CSS **100 % semánticos**, prohibidas clases con nombres de color de marca en duro) + shadcn/ui, `pnpm` + Turborepo, Prisma multi-file + Supabase PostgreSQL **17**, Cloudflare R2.
3. **Exactitud financiera y horaria:** todo valor monetario usa **`BigInt` (`INT8`) en centavos COP enteros** (`CHECK >= 0`, cero floats, cero `INT4` monetario — `ADR-002`). Fechas siempre formateadas en `America/Bogota` (`UTC-5`).
4. **Idioma y nomenclatura:** marca **«MundoNetTech»** consumida desde `config/store.config.ts`. UI y correos en español de Colombia (`es-CO`, **tuteo** estricto; voseo bloqueado en CI); código, modelos Prisma y Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`) en inglés; documentación en español.
5. **Seguridad mandatoria desde Fase 0 (`ADR-005`):** 3 anillos RBAC + **MFA TOTP `aal2` obligatorio** en `/admin` + step-up MFA (`≤ 10 min`) en acciones sensibles/financieras + máscara PII server-side + `AdminActionLog` (`selfDealing`). 100 % RLS *deny-by-default* con trigger `enforce_rls_on_new_table` y PostgREST revocado. Credenciales comerciales externas en Bóveda cifrada `IntegrationCredential` (`AES-256-GCM`).
6. **Higiene de Git y documentos vivos (`ADR-018`):**
   - `tmp/` es scratch local gitignored: no lo explores ni uses como fuente de verdad (`make clean-tmp`).
   - **Cero arqueología:** prohibido apilar bitácoras fechadas o carpetas `_archive/`. La historia vive en `git log`. Los documentos describen **únicamente el presente** y se actualizan en el sitio.
   - `packages/db/prisma/schema/*.prisma` es la única fuente de verdad de tablas y columnas.

## 3. Flujo Dual Obligatorio (Implementador → Auditor/Certificador)

- **Estados en `docs/PLAN.md`:** `[ ]` Pendiente · **`[R]`** Implementado (listo para auditoría) · **`[x]`** Auditado y certificado.
- **Inicio de toda sesión:** lee `AGENTS.md` → `docs/STATE.md` → `docs/PLAN.md` + `git status` y `git log -5`. Trabaja solo el bloque acordado (`FX.Y`) sobre una rama creada desde `develop` (ej. `feat/f0-2-...`).
- **Agente Implementador:** construye el 100 % de `FX.Y`, deja en verde `make check && pnpm test` (+ `pnpm build` si toca rutas, config o `proxy.ts`), registra decisiones nuevas en `docs/DECISIONS.md` (`3–6` lín.), marca `FX.Y` como **`[R]`** en `docs/PLAN.md` y hace commit en su rama (**nunca marca `[x]` ni fusiona a `develop`**).
- **Agente Auditor/Certificador:** revisa de forma adversarial `git diff develop...HEAD` contra `ARCHITECTURE.md` y `DECISIONS.md` (seguridad, RLS/MFA `aal2`, `BigInt`, concurrencia, Next 16 `'use cache'`, frontera `config/` ↔ `packages/` y tests negativos), corrige en el sitio cualquier brecha, reejecuta todos los gates, pasa `FX.Y` de `[R]` a **`[x]`**, actualiza `docs/STATE.md` + Handoff en `docs/PLAN.md` (compactando a 1 línea `✅` fases cerradas) y sube/actualiza el PR contra `develop`.
- **Ramas protegidas:** `develop` (STG) y `production` (PRD); prohibido push directo, force-push o versionar secretos/archivos temporales.
