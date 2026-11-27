# Plan Maestro Vivo — MundoNetTech (`mundonettech.co`)

> **Workboard Nivel 0 (≤ 160 lín.).** Estados: `[ ]` pendiente · `[R]` en auditoría · `[x]` certificado. Expande solo la fase activa; compacta cerradas a 1 línea `✅`. Arquitectura en [`ARCHITECTURE.md`](ARCHITECTURE.md).

## 1. Mapa Ejecutivo de Hitos y Fases

| Hito | Fase | Alcance resumido | Estado |
| --- | --- | --- | :---: |
| **Hito 1 — Go-Live** | **Fases 0–4A (`F0.1`–`F4A.3`)** | Fundación/RLS/MFA `aal2`/Bóveda, Catálogo/R2/360°/3D/WAC, CMS/Legal/SEO, Checkout/IVA/Pagos/Envíos/DIAN, Operación/`3.500 UVT`/RMA/PQR/Gates. | `[x]` |
| **Hito 2 — Escala** | **Fases 4B–6 (`F4B.1`–`F6.4`)** | CRM 360 + B2B + Copiloto 0-PII, Lealtad + Lifecycle + Salud/Backups GPG/DR + Ayuda v2, Mercado Libre `MCO` + Meta Catalog/CAPI. | `[x]` |
| **Compuerta Código** | **Auditoría Integral (`A1`–`A10`)** | 3 cortes estructurales (`A1`–`A3`) + 5 espejos `Admin ↔ Cliente` (`A4`–`A8`) + UX/Ops (`A9`–`A10`), multi-agente 0-supuestos. | `[x]` |
| **Compuerta Calle** | **Maduración Operativa (`M1`–`M4`)** | `M1` Rodaje `:4010` + marca · `M2` Legal + `STG` · `M3` Go-Live `mundonettech.co` · `M4` Meta/ML `MCO`. | `[/]` |
| **Hito 3 (Diferido)** | **Fase 7 — WhatsApp + Agente IA** | **Congelada hasta cerrar `M1`–`M4`:** Cloud API + Gemini TS (`packages/core`) + Inbox `/admin/whatsapp`. | `[ ]` |

---

## 2. Fase Activa — Compuerta Calle (`M1`–`M4`)

- `[x]` ✅ **Fases 0–6 (`F0.1`–`F6.4`, `ADR-001`..`045`):** núcleo retail/mayorista completo en PG 17 + Next 16 (`29` Cliente, `43` Admin, `24` APIs, `133` tablas).
- `[x]` ✅ **Auditoría Integral Pre-Calle (`A1`–`A10`, `ADR-046`..`055`):** `guard:ast` + `guard:security-surface`, CSRF/cookies/SSRF/cuotas/uploads, manifiesto PG17 exacto (`133` tablas/`48` mig./`629` índices/`2.309` RLS), espejos `Admin ↔ Cliente` (catálogo, checkout/DIAN, posventa/finanzas, CRM/B2B/crecimiento, ML `MCO`/Meta CAPI/bóveda), UX/WCAG AA/tuteo (`A9`), jobs/health, backup GPG/DR streaming + triggers, `/admin/{salud,usuarios,seguridad,auditoria}` sin split-brain, docs Nivel 1/2, `ci.yml` paralelo SHA-pinned y rulesets activos (`develop`/`production`).
- `[ ]` **`M1` — Rodaje local `:4010` + identidad comercial (`ops/m1-local-rodaje-brand`):** validar operación real sobre `:4010` (`verify:local-stack` + `bootstrap:admin`), revisar identidad/catálogo/marca en `config/` y dejar checklist de marca y copy listos para `STG`.
- `[ ]` **`M2` — Revisión Legal + Aprovisionamiento `STG`:** validar textos Ley 1480/1581/2300/DIAN, desplegar Preview de `develop` con Supabase STG/R2/Turnstile/Resend independientes y correr `release:verify` + QA en `STG`.
- `[ ]` **`M3` — Go-Live `mundonettech.co` (`develop → production`):** PR protegido con revisión humana (`protect-production`), `release:verify` PRD en verde, migraciones hacia adelante, backup GPG + primer `dr:drill` remoto y monitoreo de salud.
- `[ ]` **`M4` — Canales externos (`Meta Catalog/CAPI` + `Mercado Libre MCO`):** activar credenciales de producción, sincronizar catálogo/pedidos y habilitar **`Fase 7` (WhatsApp + Agente IA)**.

---

## 3. Handoff

- **Siguiente:** **Implementador `M1`** (desde `develop` limpio → rama `ops/m1-local-rodaje-brand`): ejecutar rodaje real en `:4010` (`verify:local-stack`, `bootstrap:admin`, flujos cliente y `/admin`), completar activos/identidad comercial en `config/` y preparar entrada a `M2` (`STG`).
- **Leer:** `AGENTS.md`, `docs/STATE.md`, `docs/PLAN.md`, `docs/OPERATIONS.md`, `docs/SECURITY.md` y `docs/COMPLIANCE.md`.
- **Certificado `[x]` (`A10`, `ADR-055`):** `634` AST, `48` mig., `588` `CHECK`, `152` funcs, `629` índices, `260` triggers, `1.386` pruebas, `2.309` RLS, `92` E2E, OWASP, k6 (`0` deadlocks/`76` inv.), Lighthouse (`96–100`), build, `audit:dependencies` y rulesets activos (`develop`/`production`).
