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
| **Hito 2 — Escala** | **Fase 4B — CRM 360 y Canal B2B** | `F4B.1` `Contact` 360° + duplicados + tareas + retención Hábeas Data · `F4B.2` `PriceList` B2B + `/empresas` → `/propuesta/[token]` `BigInt` → `Order` + Copiloto 0-PII. | `[x]` |
| **Hito 2** | **Fase 5 — Lealtad, Lifecycle y Observabilidad** | `F5.1` Puntos (reversa `EARN`) + Referidos + Abandonados · `F5.2` Lifecycle + Segmentos Ley 1581 + RFM/LTV · `F5.3` Salud + Alertas + Backups GPG R2 streaming + DR drill + Ayuda v2. | `[ ]` |
| **Hito 2** | **Fase 6 — Omnicanal ML `MCO` + Meta CAPI** | `F6.1` OAuth PKCE · `F6.2` User Products + `x-version` + Full + precios (zona muerta \$60k) · `F6.3` `ChannelPack`/`ChannelOrder` + `ME2`/Flex + conciliación · `F6.4` Meta Catalog + CAPI. | `[ ]` |
| **Hito 3 (Opc.)** | **Fase 7 — WhatsApp + Agente IA** | WhatsApp Cloud API + Agente Gemini TS sobre `packages/core` + Inbox humano con *takeover*. | `[ ]` |

---

## 2. Fase Activa — Fase 5: Lealtad, Lifecycle y Observabilidad

- `[x]` ✅ **Fases 0–4B (`F0.1`–`F4B.2`):** MFA `aal2`/RLS/Bóveda (`ADR-019`..`022`), Catálogo/Media R2/WAC (`ADR-023`..`026`), CMS v3/Legal CO/SEO (`ADR-027`..`029`), Carrito/Checkout/Pagos/Logística/DIAN (`ADR-030`..`033`), Operación/`3.500 UVT`/RMA/PQR/Reseñas + OWASP/E2E+axe/Lighthouse `96–100`/k6/`release:verify` (`ADR-034`..`036`) y CRM 360° + Canal B2B/Copiloto 0-PII (`ADR-037`..`038`; Go-Live sujeto a externos).
- `[x]` ✅ **`F5.1` — Lealtad, Referidos y Abandonados:** `LoyaltyTxn` (`CHECK >= 0`, FK `orderId`/`refundId`/`paymentTransactionId`, reversa *half-up* y `FORFEIT`), referidos (`__Host-mnt_referral`), recuperación `AbandonedCart` Ley 1581/RFC 8058 y `/mi-cuenta/beneficios` + `/admin/fidelizacion` MFA + RLS (`ADR-039`).
- `[x]` ✅ **`F5.2` — Journeys Lifecycle, Segmentos Ley 1581 y Analítica RFM/LTV:** `CustomerSegment` + evidencia append-only de membresía/consentimiento, `LifecycleJourney`/`Step`/`Enrollment`/`Message` con despachos versionados e idempotentes 0-PII en `DomainOutbox`, pausa/reanudación sin dead-letter, supresión efectiva y RFM/LTV `BigInt` neto en `/admin/{segmentos,lifecycle,analitica-rfm}` MFA + RLS (`ADR-040`).
- `[ ]` **`F5.3` — Salud Operativa, Alertas, Backups GPG R2 Streaming, DR Drill y Ayuda v2:** monitoreo y alertas accionables sin RUM crudo en OLTP (`ADR-017`), respaldos cifrados GPG (`--passphrase-fd 3`) hacia Cloudflare R2 por streaming multipart (cero `Buffer.concat` en RAM), simulacro DR mensual automatizado (`≤ 36 h`, esquema `auth` y 100 % de buckets) y Centro de Ayuda v2 accesible.

---

## 3. Handoff para la siguiente sesión

- **Siguiente turno — Implementador (`F5.3`):** partir de `develop` limpio en `feat/f5-3-health-alerts-backups-dr-help-v2`, construir salud operativa + alertas sin RUM crudo en OLTP (`ADR-017`), backups GPG (`--passphrase-fd 3`) a R2 por streaming multipart, simulacro DR automatizado (`≤ 36 h`, `auth` y buckets) y Centro de Ayuda v2 accesible, pasar `make check && pnpm test && pnpm test:rls && pnpm build && pnpm test:e2e`, anotar `ADR-041`, marcar `[R]` en `PLAN.md` y pasar turno al Auditor.
