# Plan Maestro Vivo — MundoNetTech (`mundonettech.co`)

> **Workboard vivo de Nivel 0 (≤ 160 lín.).** Estados: `[ ]` pendiente · `[R]` implementado (en auditoría) · `[x]` certificado. Expande solo la fase activa; compacta fases cerradas a 1 línea `✅`. Detalle en [`ARCHITECTURE.md`](ARCHITECTURE.md).

## 1. Mapa Ejecutivo de Hitos y Fases

| Hito | Fase | Alcance resumido | Estado |
| --- | --- | --- | :---: |
| **Hito 1 — Go-Live** | **Fase 0 — Fundación, Seguridad y Shell Admin** | Gobernanza, Next 16, PG 17 `BigInt` + RLS + Bóveda + Outbox, Auth + Admin **MFA `aal2`** + RBAC 8 roles + PII mask y CI/Gates (`F0.1`–`F0.5`). | `[x]` |
| **Hito 1** | **Fase 1 — Catálogo Tech, Media 360°/3D e Inventario WAC** | Catálogo/Facetas/GS1/Bundles (`F1.1`), `packages/media` R2/360°/3D (`F1.2`), Multi-bodega WAC/CSV (`F1.3`), `CatalogService` `'use cache'`/PDP/Admin (`F1.4`). | `[x]` |
| **Hito 1** | **Fase 2 — CMS v3, SEO y Legal CO** | CMS Zod + `StoreSettings` + R2 (`F2.1`), `/pagina/[slug]` PPR + Live Edit + SERP (`F2.2`), `packages/legal-co` + `UrlRedirect` + JSON-LD/Sitemap/Merchant XML (`F2.3`). | `[x]` |
| **Hito 1** | **Fase 3 — Carrito, Checkout, IVA Dual, Pagos y Logística** | `F3.1` Carrito/Mayorista/Bundles/Cupones/`/pagar/[token]` · `F3.2` Checkout DANE + IVA Dual/UVT + `OrderReceipt` + Outbox · `F3.3` Bóveda + Pagos · `F3.4` Aveonline/Flex + Resend/Svix + DIAN. | `[x]` |
| **Hito 1** | **Fase 4A — Operación, RMA/Seriales y Lanzamiento** | `F4A.1` `/admin/{hoy,dashboard,pedidos,finanzas}` (`OrderRefund`) + `3.500 UVT` · `F4A.2` `/mi-cuenta/*` + `/pedido/[token]` 2FA + RMA (`SerializedUnit`) + PQR SLA + Reseñas · `F4A.3` OWASP + E2E + axe + Lighthouse ≥ 95 + k6 + `release:verify` (**Go-Live** real sujeto a externos). | `[x]` |
| **Hito 2 — Escala** | **Fase 4B — CRM 360 y Canal B2B** | `F4B.1` `Contact` 360° + duplicados + tareas + retención Hábeas Data · `F4B.2` `PriceList` B2B + `/empresas` → `/propuesta/[token]` `BigInt` → `Order` + Copiloto 0-PII. | `[ ]` |
| **Hito 2** | **Fase 5 — Lealtad, Lifecycle y Observabilidad** | `F5.1` Puntos (reversa `EARN`) + Referidos + Abandonados · `F5.2` Lifecycle + Segmentos Ley 1581 + RFM/LTV · `F5.3` Salud + Alertas + Backups GPG R2 streaming + DR drill + Ayuda v2. | `[ ]` |
| **Hito 2** | **Fase 6 — Omnicanal ML `MCO` + Meta CAPI** | `F6.1` OAuth PKCE · `F6.2` User Products + `x-version` + Full + precios (zona muerta \$60k) · `F6.3` `ChannelPack`/`ChannelOrder` + `ME2`/Flex + conciliación · `F6.4` Meta Catalog + CAPI. | `[ ]` |
| **Hito 3 (Opc.)** | **Fase 7 — WhatsApp + Agente IA** | WhatsApp Cloud API + Agente Gemini TS sobre `packages/core` + Inbox humano con *takeover*. | `[ ]` |

---

## 2. Fase Activa — Fase 4B: CRM 360 y Canal B2B

- `[x]` ✅ **Fases 0–4A (`F0.1`–`F4A.3`):** MFA `aal2`/RLS/Bóveda (`ADR-019`..`022`), Catálogo/Media R2/WAC (`ADR-023`..`026`), CMS v3/Legal CO/SEO (`ADR-027`..`029`), Carrito/Checkout/Pagos/Aveonline/Flex/Resend/DIAN (`ADR-030`..`033`) y Operación/`3.500 UVT`/RMA/PQR/Reseñas + OWASP/E2E+axe/Lighthouse `96–100`/k6/`release:verify` (`ADR-034`..`036`; Go-Live real sujeto a externos y aprobaciones humanas).
- `[x]` ✅ **`F4B.1` — CRM 360°, Identidades/Duplicados, Tareas y Retención Hábeas Data:** `Organization` (`priceListId` opc., `taxId` serializado), `Contact` 360° (4 niveles, sin regalos), `ContactIdentity`, `IdentityMergeCandidate` (pares exactos + fusión/reversa Anillo 1 MFA), `ContactActivity`, cola `Task` + `/admin/hoy` y supresión Ley 1581 bidireccional (`/admin/crm` + `/mi-cuenta` + `CRM_JOB_ACTOR_ID`, `ADR-037`).
- `[ ]` **`F4B.2` — Listas de Precios B2B, `/empresas`, `/propuesta/[token]` y Copiloto 0-PII:** `PriceList` + `PriceListItem` (`BigInt`), captura comercial `/empresas` → `Opportunity` + `OpportunityProposal` (`BigInt` + `taxCents` dual) + `OpportunityProposalItem` versionada y aceptable/firmable en `/propuesta/[token]` (`noindex`/`no-store`, token hash) → conversión transaccional a `Order`, `/admin/b2b` MFA y Copiloto Gemini 0-PII en `packages/integrations`.

---

## 3. Handoff para la siguiente sesión

- **Siguiente turno — Implementador (`F4B.2`):** partir de `develop` limpio y crear rama `feat/f4b-2-b2b-pricelists-proposals-copilot`, implementar el 100 % de `F4B.2` (`PriceList` + `PriceListItem` `BigInt` sobre `Organization.priceListId`, `/empresas` → `Opportunity` + `OpportunityProposal` `BigInt` + `taxCents` dual + `OpportunityProposalItem` versionada y aceptable/firmable en `/propuesta/[token]` `noindex`/`no-store` con token hash → conversión transaccional a `Order`, `/admin/b2b` MFA y Copiloto Gemini 0-PII en `packages/integrations`), pasar gates (`make check && pnpm test && pnpm test:rls && pnpm build && pnpm test:e2e`), marcar `[R]` y relevar al **Auditor**. (El Go-Live real permanece cerrado en `release:verify` hasta STG/PRD, datos legales, proveedores y aprobaciones humanas).
