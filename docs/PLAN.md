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
| **Hito 2** | **Fase 5 — Lealtad, Lifecycle y Observabilidad** | `F5.1` Puntos (reversa `EARN`) + Referidos + Abandonados · `F5.2` Lifecycle + Segmentos Ley 1581 + RFM/LTV · `F5.3` Salud + Alertas + Backups GPG R2 streaming + DR drill + Ayuda v2. | `[x]` |
| **Hito 2** | **Fase 6 — Omnicanal ML `MCO` + Meta CAPI** | `F6.1` OAuth PKCE · `F6.2` User Products + `x-version` + Full + precios (zona muerta \$60k) · `F6.3` `ChannelPack`/`ChannelOrder` + `ME2`/Flex + conciliación · `F6.4` Meta Catalog + CAPI. | `[R]` |
| **Hito 3 (Opc.)** | **Fase 7 — WhatsApp + Agente IA** | WhatsApp Cloud API + Agente Gemini TS sobre `packages/core` + Inbox humano con *takeover*. | `[ ]` |

---

## 2. Fase Activa — Fase 6: Omnicanal ML `MCO` + Meta CAPI

- `[x]` ✅ **Fases 0–5 (`F0.1`–`F5.3`):** MFA `aal2`/RLS/Bóveda (`ADR-019`..`022`), Catálogo/Media R2/WAC (`ADR-023`..`026`), CMS v3/Legal CO/SEO (`ADR-027`..`029`), Carrito/Checkout/Pagos/Logística/DIAN (`ADR-030`..`033`), Operación/`3.500 UVT`/RMA/PQR/Reseñas + OWASP/E2E+axe/Lighthouse `96–100`/k6/`release:verify` (`ADR-034`..`036`), CRM 360° + B2B/Copiloto 0-PII (`ADR-037`..`038`) y Lealtad/Lifecycle/RFM + Salud/Backups GPG R2/DR/Ayuda v2 (`ADR-039`..`041`; Go-Live sujeto a externos).
- `[x]` ✅ **`F6.1` — OAuth PKCE y `ChannelAccount`:** ML `MCO` PKCE `S256` (`__Secure-`), bóveda aislada, renovación fail-closed, `channels.reauth` y `/admin/canales` MFA + RLS (`ADR-042`).
- `[x]` ✅ **`F6.2` — User Products ML `MCO`, `x-version`, Full y Precios \$60k:** `ChannelListing`/`ChannelOffer` `BigInt`, stock local/Full, jobs y conciliación MFA + RLS (`ADR-043`).
- `[x]` ✅ **`F6.3` — Packs/órdenes, ME2/Flex/Full y conciliación:** webhooks HMAC + outbox 0-PII, `ChannelPack`/`ChannelOrder`/`ChannelShipment`, reserva/descuento serializado y `ChannelLedgerEntry` `BigInt` append-only + UI MFA/RLS (`ADR-044`; 130 tablas/2.255 casos).
- `[R]` **`F6.4` — Meta Catalog Feed + Conversions API (CAPI):** CSV por variante con imagen/COP/inventario/GTIN/MPN reales y diagnóstico; `Purchase` server-side deduplicado por orden/`event_id` con request hash, `ADVERTISING` vigente al pago/despacho, bóveda AES-256-GCM, purga de hashes, claims/backoff y conciliación MFA sin reenvío ciego (`ADR-045`; 131 tablas/2.272 casos).

---

## 3. Handoff para la siguiente sesión

- **Siguiente turno — Auditor/Certificador (`F6.4`):** auditar `git diff develop...HEAD` contra `ARCHITECTURE.md` y `DECISIONS.md` (`ADR-045`), seguridad, RLS/MFA, `BigInt`, privacidad, idempotencia, Next 16, frontera `config/` ↔ `packages/`, completitud anti-demo y pruebas negativas. Ya ejecutados y en verde: `make check`, 154 pruebas unitarias, 279 integración PG17, 2.272 denegaciones RLS (131 tablas), 70 escenarios E2E standalone, OWASP, `pnpm build` y auditoría de dependencias. Reejecutar `make check && pnpm test && pnpm build`, elevar cualquier superficialidad a estándar productivo, marcar `[x]`, actualizar `docs/STATE.md` + Handoff, subir rama, abrir PR, validar CI y fusionar con `--squash --delete-branch`, dejando local limpio en `develop`.
