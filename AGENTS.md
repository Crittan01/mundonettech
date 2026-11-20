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

1. **Calidad productiva y modularidad (`ADR-001`):** e-commerce retail/mayorista de tecnología y accesorios multimarca (`mundonettech.co`). Cero prototipos. Toda identidad visual, marca y reglas propias viven en `config/`; los dominios viven en `packages/*` sin strings de marca quemados.
2. **Stack estricto:** Next.js **16** (`proxy.ts`, APIs dinámicas async, `'use cache'`, `output: "standalone"` — revisa `apps/web/node_modules/next/dist/docs/`) + React 19 + TS strict (`noUncheckedIndexedAccess`, cero `any`) + Tailwind v4 (tokens CSS **100 % semánticos**, cero colores en duro) + shadcn/ui, `pnpm` + Turborepo, Prisma multi-file + Supabase PG **17**, Cloudflare R2.
3. **Exactitud financiera y horaria (`ADR-002`):** montos en **`BigInt` (`INT8`) centavos COP enteros** (`CHECK >= 0`, cero floats/INT4 monetario). Zona horaria `America/Bogota` (`UTC-5`).
4. **Idioma y nomenclatura:** marca **«MundoNetTech»** desde `config/store.config.ts`. UI/correos en `es-CO` (**tuteo** estricto; voseo bloqueado en CI); código, Prisma y Conventional Commits en inglés; docs en español.
5. **Seguridad desde Fase 0 (`ADR-005`):** 3 anillos RBAC + **MFA TOTP `aal2` obligatorio** en `/admin` + step-up MFA (`≤ 10 min`) + máscara PII server-side + `AdminActionLog` (`selfDealing`). 100 % RLS *deny-by-default* con `enforce_rls_on_new_table` y PostgREST revocado. Secretos externos en `IntegrationCredential` (`AES-256-GCM`).
6. **Higiene Git y docs vivos (`ADR-018`):** `tmp/` gitignored (`make clean-tmp`); prohibido apilar bitácoras fechadas o `_archive/` (historia en `git log`; docs describen solo el presente). `packages/db/prisma/schema/*.prisma` es única fuente de verdad del esquema.
7. **Host compartido (cero colisiones):** prohibido `npm/pnpm -g`, `corepack` global, `sudo`/`dnf` y `pkill`/`killall` genéricos; usar solo PIDs propios, puertos `:4010`, `:4110`, `:54420..54429` y filtros Podman acotados a `_mundonettech`.

## 3. Flujo Dual Obligatorio y Relevo Automático (Implementador ↔ Auditor)

- **Estados en `docs/PLAN.md`:** `[ ]` Pendiente · **`[R]`** Implementado (listo para auditoría) · **`[x]`** Certificado y fusionado en `develop`.
- **Inicio de toda sesión:** lee `AGENTS.md` → `docs/STATE.md` → `docs/PLAN.md` + `git status` y `git log -5`.
- **Agente Implementador:** verifica estar sobre `develop` limpio y al día (`git checkout develop && git pull --ff-only origin develop`; aborta si existe un PR abierto sin fusionar), crea la rama indicada en el *Handoff* de `docs/PLAN.md`, construye el 100 % del bloque, pasa `make check && pnpm test` (+ `pnpm build` si toca rutas, config o `proxy.ts`), anota ADRs nuevos (`3–6` lín.), marca el bloque como **`[R]`** en `docs/PLAN.md`, hace commit en su rama (**sin abrir PR ni tocar `develop`**) y cierra indicando pasar turno al **Agente Auditor/Certificador**.
- **Agente Auditor/Certificador:** audita de forma adversarial `git diff develop...HEAD` contra `ARCHITECTURE.md` y `DECISIONS.md` (seguridad, RLS/MFA `aal2`, `BigInt`, concurrencia, Next 16 `'use cache'`, frontera `config/` ↔ `packages/` y tests negativos), corrige en el sitio cualquier brecha, reejecuta todos los gates, pasa el bloque a **`[x]`**, actualiza `docs/STATE.md` + *Handoff* del siguiente bloque en `docs/PLAN.md` (compactando fases cerradas a 1 línea `✅`), sube la rama, abre/actualiza el PR contra `develop`, verifica CI en verde (desde `F0.5`), **fusiona con `gh pr merge --squash --delete-branch` y deja el workspace local limpio en `develop`** (`git checkout develop && git pull --ff-only origin develop`), indicando pasar turno al **Agente Implementador**.
- **Ramas protegidas:** prohibido push directo o force-push a `develop` (STG) y `production` (PRD); todo pase `develop → production` exige aprobación humana explícita.
