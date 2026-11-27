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
- `[x]` ✅ **`M1` — Rodaje local `:4010` + identidad comercial (`ADR-056`):** rodaje real validado (`verify:local-stack`, `admin:bootstrap`, seed y QA visual `375 px`/`1440 px` con sesión TOTP `aal2`), paleta OKLCH «Midnight Cyan» (`34` tokens AA), `BrandMark`/activos de marca/OG, fuentes WOFF2 locales con `tnum`, Storefront rediseñado (`loading.tsx` por ruta dinámica, `404` real en PDP, `next/dynamic` en visores) y `/admin` con sidebar oscuro agrupado + topbar/breadcrumb + paleta `Cmd+K` WAI-ARIA filtrada por RBAC.
- `[ ]` **`M2` — Revisión Legal + Aprovisionamiento `STG` (`ops/m2-legal-stg`):** validar textos Ley 1480/1581/2300/DIAN, desplegar Preview de `develop` con Supabase STG/R2/Turnstile/Resend independientes y correr `release:verify` + QA en `STG`.
- `[ ]` **`M3` — Go-Live `mundonettech.co` (`develop → production`):** PR protegido con revisión humana (`protect-production`), `release:verify` PRD en verde, migraciones hacia adelante, backup GPG + primer `dr:drill` remoto y monitoreo de salud.
- `[ ]` **`M4` — Canales externos (`Meta Catalog/CAPI` + `Mercado Libre MCO`):** activar credenciales de producción, sincronizar catálogo/pedidos y habilitar **`Fase 7` (WhatsApp + Agente IA)**.

---

## 3. Handoff

- **Siguiente:** **Implementador `M2`** (desde `develop` limpio → rama `ops/m2-legal-stg`): completar revisión legal de textos Ley 1480/1581/2300/DIAN en `packages/legal-co` y `config/`, aprovisionar entorno `STG` independiente (Supabase STG, R2, Turnstile, Resend, Vercel Preview de `develop`) y ejecutar `release:verify` + QA integral en `STG`.
- **Leer:** `AGENTS.md`, `docs/STATE.md`, `docs/PLAN.md`, `docs/OPERATIONS.md`, `docs/SECURITY.md` y `docs/COMPLIANCE.md`.
- **Certificado `[x]` (`M1`, `ADR-056`):** `648` AST, `48` mig., `588` `CHECK`, `152` funcs, `629` índices, `260` triggers, `1.390` pruebas, `2.309` RLS, `92` E2E, OWASP, k6 (`0` deadlocks/`76` inv.), Lighthouse (`99–100`, `7/8` en `100`), build (`122/122`), `audit:dependencies` y QA visual `:4010` (`0` overflow/`0` axe).
