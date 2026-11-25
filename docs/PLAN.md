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

- `[x]` ✅ **Fases 0–6 en CI (`F0.1`–`F6.4`, `ADR-001`..`045`):** `474` archivos, `29` págs. Cliente, `43` págs. Admin, `22` APIs, `131` tablas PG 17 y `99` suites.
- `[x]` ✅ **`A1` — Grafo AST, Código Muerto y Caché (`ADR-046`):** `guard:ast` en `make check`, `ProductMediaService` R2 y generación `UrlRedirectCacheState` con paridad 1:1.
- `[x]` ✅ **`A2` — Seguridad Zero-Trust (`ADR-047`):** `guard:security-surface` (56 módulos/166 actions/168 handlers/proxy), CSRF MPA, cookies `httpOnly`/TOTP, SSRF/HMAC/cuotas, uploads streaming y `2.306` RLS.
- `[x]` ✅ **`A3` — Esquema PG 17, Índices y Concurrencia (`ADR-048`):** manifiesto `133` tablas/`579` CHECK/`274` FK/`143` funcs (`search_path` fijo)/`622` índices/`244` triggers/`40` mig., `attacl`/`authenticator`/`pg_default_acl`, soft-delete/`UrlRedirectCacheState`, jerarquías acíclicas, `AdminUser FOR SHARE`, fences y barridos sin inanición (`1.072` pruebas, `2.306` RLS, k6 `0` deadlocks/`76` inv.).
- `[ ]` **`A4` — Espejo Admin ↔ Cliente: Catálogo, Media 360°/3D, WAC, Precios y CMS/SEO (`audit/a4-catalog-media-cms`):** cruzar `/admin/{catalogo,precios,contenido,configuracion}` ↔ `/`, `/productos`, `/categoria`, `/marca`, `/producto`, `/comparar`, `/pagina`, `/ayuda`, `/legal`, `/sitemap*`: toda mutación Admin refleja al instante en Cliente/JSON-LD sin caché obsoleta.
- `[ ]` **`A5` — Espejo Admin ↔ Cliente: Carrito, Checkout, Venta Asistida, Pagos, Logística y DIAN (`audit/a5-checkout-payments-shipping`):** cruzar `/carrito`, `/checkout`, `/pagar/[token]`, `/recibo/[token]` ↔ `/admin/{venta-asistida,pagos,logistica,pedidos,facturacion}` + Wompi/Aveonline/Flex/Resend/Outbox: `safetyStock`, cupones, IVA dual/UVT, *pick & pack* multi-bulto y recibos/DIAN punta a punta.
- `[ ]` **`A6` — Espejo Admin ↔ Cliente: Cuenta, Posventa 2FA, RMA/Seriales, PQR, Reseñas y Finanzas (`audit/a6-postsale-rma-finance`):** cruzar `(auth)/*`, `/mi-cuenta/*`, `/pedido/[token]` ↔ `/admin/{hoy,dashboard,posventa,resenas,finanzas}`: retracto (18 festivos CO), garantías/cambios `SerializedUnit` (Serial/IMEI), moderación, `OrderRefund` y cuadre `BigInt` + `3.500 UVT`.
- `[ ]` **`A7` — Espejo Admin ↔ Cliente: CRM 360, B2B, Lealtad/Referidos y Lifecycle (`audit/a7-crm-b2b-loyalty`):** cruzar `/empresas`, `/propuesta/[token]`, `/mi-cuenta/{beneficios,privacidad}`, `/referido/[code]`, `/email/baja/[token]` ↔ `/admin/{crm,b2b,fidelizacion,segmentos,lifecycle,analitica-rfm,comunicaciones}` + Copiloto 0-PII: `PriceList` → `Order`, reversa `EARN`, anti-`selfDealing` y supresión Ley 1581 / RFC 8058.
- `[ ]` **`A8` — Espejo Omnicanal ↔ Core: Mercado Libre `MCO`, Meta CAPI y Bóveda (`audit/a8-omnichannel-vault`):** cruzar `/admin/{integraciones,canales}`, OAuth/webhook ML, `/api/feeds/{google-merchant,meta-catalog}`, `/api/metrics/funnel` ↔ stock `x-version`, cancelaciones/`ChannelLedgerEntry`, revocación `ADVERTISING` sobre CAPI y feeds sin datos sintéticos.
- `[ ]` **`A9` — Navegación, UX, Estados Reales, A11y y Copy (`audit/a9-ux-navigation-a11y`):** revisar las `29` págs. Cliente y `43` págs. Admin: cero rutas fuera de menús ni links rotos, formularios/filtros/paginación reales, `loading`/`empty`/`error`, 100 % tokens semánticos, tuteo `es-CO` y WCAG 2.1 AA móvil/escritorio.
- `[ ]` **`A10` — Operación, Backups/DR, Docs Nivel 1, CI/Rulesets y Certificación (`audit/a10-ops-dr-ci-certification`):** auditar los 5 `/api/jobs/*`, `backup:create`, `dr:drill`, `release:verify`, `/admin/{salud,usuarios,seguridad,auditoria}`; sincronizar docs Nivel 1 con el código; optimizar `ci.yml` + activar rulesets (`develop`/`production`) y certificar las 8 suites habilitando `M1`.
- `[ ]` **🔒 Tras `A10`:** `M1` `:4010` + marca → `M2` `STG` → `M3` Go-Live → `M4` Meta/ML → `Fase 7`.

---

## 3. Handoff

- **Siguiente:** **Implementador `A4`** (partir de `develop` limpio → rama `audit/a4-catalog-media-cms`; espejo Admin ↔ Cliente de catálogo, media 360°/3D, WAC, precios y CMS/SEO; `feat/f7-*` congelado).
- **Leer:** `AGENTS.md`, `docs/STATE.md`, `docs/PLAN.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `packages/db/README.md`, `packages/media/README.md` y `packages/cms/README.md`.
- **Certificado `[x]` (`A3`):** 2.ª auditoría adversarial multi-agente cerrada; `40` mig./`133` tablas/`2.306` RLS, `1.072` pruebas, build, `db:verify`, k6 (`0` deadlocks/`76` inv.) y `audit:dependencies` verdes.
