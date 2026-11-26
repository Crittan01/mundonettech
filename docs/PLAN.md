# Plan Maestro Vivo — MundoNetTech (`mundonettech.co`)

> **Workboard Nivel 0 (≤ 160 lín.).** Estados: `[ ]` pendiente · `[R]` en auditoría · `[x]` certificado. Expande solo la fase activa; compacta cerradas a 1 línea `✅`. Arquitectura en [`ARCHITECTURE.md`](ARCHITECTURE.md).

## 1. Mapa Ejecutivo de Hitos y Fases

| Hito | Fase | Alcance resumido | Estado |
| --- | --- | --- | :---: |
| **Hito 1 — Go-Live** | **Fases 0–4A (`F0.1`–`F4A.3`)** | Fundación/RLS/MFA `aal2`/Bóveda, Catálogo/R2/360°/3D/WAC, CMS/Legal/SEO, Checkout/IVA/Pagos/Envíos/DIAN, Operación/`3.500 UVT`/RMA/PQR/Gates. | `[x]` |
| **Hito 2 — Escala** | **Fases 4B–6 (`F4B.1`–`F6.4`)** | CRM 360 + B2B + Copiloto 0-PII, Lealtad + Lifecycle + Salud/Backups GPG/DR + Ayuda v2, Mercado Libre `MCO` + Meta Catalog/CAPI. | `[x]` |
| **Compuerta Código** | **Auditoría Integral (`A1`–`A10`)** | 3 cortes estructurales (`A1`–`A3`) + 5 espejos `Admin ↔ Cliente` (`A4`–`A8`) + UX/Ops (`A9`–`A10`), multi-agente 0-supuestos. | `[/]` |
| **Compuerta Calle** | **Maduración Operativa (`M1`–`M4`)** | `M1` Rodaje `:4010` + marca · `M2` Legal + `STG` · `M3` Go-Live `mundonettech.co` · `M4` Meta/ML `MCO`. | `[ ]` |
| **Hito 3 (Diferido)** | **Fase 7 — WhatsApp + Agente IA** | **Congelada hasta cerrar `A1`–`A10` y `M1`–`M4`:** Cloud API + Gemini TS (`packages/core`) + Inbox `/admin/whatsapp`. | `[ ]` |

---

## 2. Fase Activa — Auditoría Integral Pre-Calle (`A1`–`A10`, 0-supuestos)

- `[x]` ✅ **Fases 0–6 (`F0.1`–`F6.4`, `ADR-001`..`045`):** núcleo retail/mayorista completo en PG 17 + Next 16 (`29` Cliente, `43` Admin, `24` APIs, `133` tablas).
- `[x]` ✅ **`A1`–`A3` Cortes Estructurales (`ADR-046`..`048`):** `guard:ast`, `guard:security-surface` (`56` mód./`166` actions/`168` handlers/proxy), CSRF/cookies/SSRF/cuotas/uploads, manifiesto PG17 exacto (`133` tablas/`47` mig./`2.309` RLS), jerarquías acíclicas, `AdminUser FOR SHARE` y fences HTTP.
- `[x]` ✅ **`A4`–`A6` Espejos Catálogo, Checkout, Posventa y Finanzas (`ADR-049`..`051`):** RBAC temprano/`FOR SHARE`, PDP/bundles/R2/360°/3D/`UrlRedirect`, checkout/Wompi/COD/Aveonline/DIAN UBL+XML-DSig/outbox, OTP invitado, anonimización bidireccional, RMA/seriales, finanzas `REPEATABLE READ` y `3.500 UVT`.
- `[x]` ✅ **`A7`–`A8` Espejos CRM, B2B, Crecimiento, Omnicanal y Bóveda (`ADR-052`..`053`):** linaje CRM (`merge`/`reverse`), `PriceList`/propuestas/Copiloto 0-PII, lealtad/referidos/lifecycle/RFM, bóveda `NO DELETE`, ML `MCO` OAuth/packs/ledger, Meta CAPI procedencia/revocación, feeds y `/api/metrics/funnel`.
- `[x]` ✅ **`A9` — Navegación, UX, Estados Reales, A11y y Copy (`ADR-054`):** `29` págs. Cliente + `43` Admin sin huérfanos (`/pedido/[token]` desde recibo, `AdminNav` Escape/ruta, `StoreNavActiveSync` `matchPrefixes`), fronteras `retry()`/`global-error`, paginación real PG17 sin inanición, `StepUpPrompt` reloj absoluto, `geolocation=(self)` exacto en `/checkout` (`<a href>`), OKLCH AA + `outline-hidden` + `17` tablas/`2` `<pre>` `tabIndex={0}` y `guard:language` voseo+ustedeo (`1.380` pruebas, `2.309` RLS, `92` E2E, OWASP y Lighthouse `96–100`).
- `[R]` **`A10` — Operación, Backups/DR, Docs Nivel 1, CI/Rulesets y Certificación (`audit/a10-ops-dr-ci-certification`, `ADR-055`):** 5 `/api/jobs/*` + `/api/health/{live,ready}` endurecidos (`verifyCronBearer`, timeout PG17, `HEAD` RFC 9110), `backup:create`/`dr:drill`/`release:verify`/`bootstrap-admin` + trigger `enforce_recovery_run_state`, `/admin/{salud,usuarios,seguridad,auditoria}` sin split-brain Auth/DB + índices `AdminActionLog`/`SecurityEvent`, docs Nivel 1/2 sincronizados, `ci.yml` paralelo + rulesets activos (`develop`/`production`) y 8 suites en verde.
- `[ ]` **🔒 Tras `A10`:** `M1` `:4010` + marca → `M2` `STG` → `M3` Go-Live → `M4` Meta/ML → `Fase 7`.

---

## 3. Handoff

- **Siguiente:** **Auditor `A10`** (rama `audit/a10-ops-dr-ci-certification`, estado `[R]`): auditar sin concesiones el 100 % del diff `develop...HEAD` (jobs/health, backup/DR/release, `/admin/{salud,usuarios,seguridad,auditoria}`, migración `20261126220000_a10_ops_audit_indexes`, docs Nivel 1/2, `ci.yml`, `turbo.json` y rulesets activos), elevar cualquier brecha a estándar productivo, reejecutar las 8 suites, certificar `[x]` y hacer squash-merge a `develop` habilitando `M1`.
- **Leer:** `AGENTS.md`, `docs/STATE.md`, `docs/PLAN.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/OPERATIONS.md` y `docs/SECURITY.md`.
- **Certificado `[x]` (`A9`, `ADR-054`):** `634` AST, `47` mig., `588` `CHECK`, `152` funcs, `624` índices, `260` triggers, `1.380` pruebas, `2.309` RLS, `92` E2E (`scrollWidth <= clientWidth`), OWASP, Lighthouse `96–100`, build y `audit:dependencies` verdes.
