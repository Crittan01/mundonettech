# Estado Actual del Proyecto — MundoNetTech (`mundonettech.co`)

> **Documento vivo de Nivel 0 (≤ 120 líneas, cero bitácoras fechadas).** Mapa completo en [`INDEX.md`](INDEX.md).

## Fotografía ejecutiva

- **Estado:** **Fase 0 en curso (`F0.1` completado → sigue `F0.2`)**.
- **Dominio y operación:** `mundonettech.co` · Numeración de órdenes `MNT-YYYY-NNNN` · E-commerce retail y mayorista de tecnología, wearables, audio, energía y accesorios multimarca en Colombia.
- **Régimen tributario:** inicia como **`NO_RESPONSABLE_IVA`** (próximo al umbral anual de `3.500 UVT`), con motor tributario dual (`NO_RESPONSABLE_IVA` ↔ `RESPONSABLE_IVA` + reglas UVT de tecnología + puerto de facturación electrónica DIAN) construido desde la base (`ADR-009`).
- **Base documental y Git (`F0.1`):** repositorio Git inicializado en rama `develop`, `.gitignore` y `.gitleaks.toml` activos, arquitectura e invariantes técnicos definidos en `docs/`.

## Topología de ambientes

| Ambiente | URL / Puertos | Estado |
| --- | --- | --- |
| **LOCAL** | Next `:4010` (`:4110` E2E) · Supabase API `:54421` · PG 17 `:54422` · Studio `:54423` · Mailpit `:54424` | Pendiente de levantar en `F0.2` / `F0.3` |
| **STG** | Rama `develop` → Preview + Supabase STG dedicado (aislamiento total de secretos respecto a PRD) | Por aprovisionar antes de cerrar Hito 1 |
| **PRD** | Rama `production` → `https://mundonettech.co` + Supabase PRD + Cloudflare R2 | Por aprovisionar en `F4A.3` |

## Capacidades operativas construidas

- **Gobernanza y arquitectura (`F0.1`):** ✅ `AGENTS.md`, `README.md`, `docs/{INDEX,STATE,PLAN,ARCHITECTURE,DECISIONS}.md`.
- **Monorepo, BD, Seguridad/Admin, Catálogo, CMS, Checkout y Omnicanal (`F0.2`–`F6`):** pendientes según [`PLAN.md`](PLAN.md).

## Pendientes externos de negocio (no bloquean Fase 0–2)

1. Definir paleta definitiva y logotipo vectorial `.svg` de **MundoNetTech** (inicia con preset semántico *Tech Precision* en `config/theme.config.ts`).
2. Cuentas propias del comercio para conectar en Fase 3 / Fase 6: Cloudflare (`mundonettech.co` + R2), Resend (`mail.mundonettech.co`), Wompi, Aveonline y App DevCenter Mercado Libre `MCO`.
