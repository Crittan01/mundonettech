# Plan Maestro Vivo — MundoNetTech (`mundonettech.co`)

> **Workboard vivo de Nivel 0 (≤ 160 lín.).** Estados: `[ ]` pendiente · `[R]` implementado (en auditoría) · `[x]` certificado. Expande solo la fase activa; compacta fases cerradas a 1 línea `✅`. Detalle en [`ARCHITECTURE.md`](ARCHITECTURE.md).

## 1. Mapa Ejecutivo de Hitos y Fases

| Hito | Fase | Alcance resumido | Estado |
| --- | --- | --- | :---: |
| **Hito 1 — Go-Live** | **Fases 0–4A (`F0.1`–`F4A.3`)** | Fundación/RLS/MFA `aal2`/Bóveda, Catálogo/R2/360°/3D/WAC, CMS/Legal/SEO, Checkout/IVA/Pagos/Envíos/DIAN, Operación/`3.500 UVT`/RMA/PQR/Gates. | `[x]` |
| **Hito 2 — Escala** | **Fases 4B–6 (`F4B.1`–`F6.4`)** | CRM 360 + B2B + Copiloto 0-PII, Lealtad + Lifecycle + Salud/Backups GPG/DR + Ayuda v2, Mercado Libre `MCO` + Meta Catalog/CAPI. | `[x]` |
| **Compuerta Código** | **Auditoría Integral Pre-Calle (`A1`–`A6`)** | Barrido multi-agente 0-supuestos: cableado/código muerto/caché, seguridad/MFA/0-PII, PG 17/locks, cuadre `BigInt`/Outbox, UI/a11y y DR/CI. | `[/]` |
| **Compuerta Calle** | **Maduración Operativa (`M1`–`M4`)** | `M1` Rodaje `:4010` + marca · `M2` Legal + `STG` · `M3` Go-Live `mundonettech.co` · `M4` Meta/ML `MCO`. | `[ ]` |
| **Hito 3 (Diferido)** | **Fase 7 — WhatsApp + Agente IA** | **Congelada hasta cerrar `A1`–`A6` y `M1`–`M4`:** Cloud API + Gemini TS (`packages/core`) + Inbox `/admin/whatsapp`. | `[ ]` |

---

## 2. Fase Activa — Auditoría Integral Pre-Calle (`A1`–`A6`, cero supuestos)

- `[x]` ✅ **Fases 0–6 construidas en CI (`F0.1`–`F6.4`, `ADR-001`..`045`):** `474` archivos, `131` tablas PG 17 (`2.272` casos RLS), `94` rutas y `99` suites base.
- `[ ]` **`A1` — Grafo AST Completo: Código Muerto, Cableado Real y Paridad de Caché (`audit/a1-ast-wiring-cache`):**
  - Auditar el 100 % de `exports`, tipos, helpers, componentes, columnas y env vars en `config/`, `packages/*` y `apps/web` + guarda reproducible en `make check`: eliminar código muerto/duplicado, conectar todo servicio de dominio huérfano a su UI/acción/worker real (cero pantallas o acciones desconectadas) y certificar paridad exacta 1:1 entre `cacheTag(...)` e invalidaciones (`updateTag`/`revalidateTag`).
- `[ ]` **`A2` — Seguridad Zero-Trust, Matriz RBAC/MFA `aal2`, 0-PII y Superficie HTTP (`audit/a2-security-rbac-mfa-pii`):**
  - Auditar una por una todas las Server Actions (`"use server"`), `route.ts`, `proxy.ts` y jobs: sesión válida, rol activo, capacidad RBAC exacta (8 roles/3 anillos), `aal2` obligatorio en `/admin`, `requireRecentMfa` (`≤ 10 min`) en toda mutación financiera/sensible/destructiva, CSRF/Origin, firmas HMAC *timing-safe* + anti-replay, rate limits, `AdminActionLog` (`selfDealing`) y cero fuga de PII, costos `WAC`, proveedores o secretos en payloads RSC/respuestas/logs.
- `[ ]` **`A3` — Esquema PG 17 (`131` tablas), Índices, RLS y Orden de Locks (`audit/a3-db-constraints-locks`):**
  - Cruzar los 11 archivos `.prisma` contra migraciones SQL y `pg_catalog`: `CHECK >= 0` en el 100 % de montos `BigInt` y stocks, índices únicos parciales `WHERE "deletedAt" IS NULL`, índices compuestos en FKs/queries calientes, reglas `ON DELETE`, cobertura total en `rls-matrix` y **orden léxico determinista de locks** en todos los flujos concurrentes (Retail, Mayorista, Bundles, Venta Asistida, B2B y ML `MCO`) contra deadlocks `40P01`.
- `[ ]` **`A4` — Cuadre Financiero `BigInt`, Tributario (`3.500 UVT`/IVA/DIAN), RMA/Seriales y Outbox (`audit/a4-financial-tax-outbox`):**
  - Trazar extremo a extremo cada origen de orden y cada desenlace (Wompi/COD/Transferencia/`StoreCredit`, reembolso parcial/total `OrderRefund`, retracto con los **18 festivos CO**, cambios/garantías RMA con `SerializedUnit` Serial/IMEI, notas crédito DIAN, reversa de puntos `EARN` y `ChannelLedgerEntry`): certificar cuadre al centavo en `/admin/finanzas`, `OrderReceipt` y `FiscalWatchSnapshot`, y auditar `DomainOutbox` + los 5 workers contra eventos sin consumidor, carreras o efectos duplicados.
- `[ ]` **`A5` — Capa Cliente y `/admin` (`94` rutas), Navegación, Estados Reales y A11y (`audit/a5-ux-admin-storefront-a11y`):**
  - Revisar las 94 páginas/rutas en móvil y escritorio: navegación 100 % conectada (cero páginas válidas fuera de menús ni enlaces rotos), formularios/filtros/paginación reales, estados completos (`loading`, `empty`, `error`), 100 % tokens semánticos, tuteo `es-CO`, SEO/JSON-LD/feeds sin datos sintéticos y accesibilidad WCAG 2.1 AA.
- `[ ]` **`A6` — Operación, Backups GPG/DR, Endurecimiento CI/Rulesets y Certificación Maestra (`audit/a6-ops-dr-ci-certification`):**
  - Auditar los 5 jobs `/api/jobs/*`, `backup:create` streaming GPG → R2, `dr:drill`, `release:verify` y `/admin/salud`; optimizar `ci.yml` (caché Chromium sin `install-deps` redundante + `gitleaks`), dejar listo ruleset de protección de ramas (`develop`/`production` con firma + CI) y ejecutar en verde las 8 suites maestras habilitando `M1`–`M4`.
- `[ ]` **🔒 Siguientes etapas tras `A6`:** `M1` Rodaje humano `:4010` + marca → `M2` `STG` → `M3` Go-Live `mundonettech.co` → `M4` Meta/ML `MCO` → `Fase 7`.

---

## 3. Handoff para la siguiente sesión

- **Siguiente bloque:** **`A1`** en rama `audit/a1-ast-wiring-cache` desde `develop` (congelado `feat/f7-*`).
- **Leer al iniciar:** `AGENTS.md`, `docs/STATE.md`, `docs/PLAN.md`, `docs/ARCHITECTURE.md` y `docs/DECISIONS.md`.
- **Cierre dual `A1`:** Implementador audita con subagentes paralelos `config/`, `packages/*` y `apps/web`, elimina código muerto, conecta todo cabo suelto, valida paridad 1:1 de `cacheTag`, suma guarda AST en `make check` y entrega en `[R]` con `make check && pnpm test && pnpm build` en verde; Auditor reaudita al 100 %, certifica `[x]` y fusiona PR en `develop`.
