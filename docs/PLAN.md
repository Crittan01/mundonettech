# Plan Maestro Vivo — MundoNetTech (`mundonettech.co`)

> **Workboard vivo de Nivel 0 (≤ 160 lín.).** Estados: `[ ]` pendiente · `[R]` implementado (en auditoría) · `[x]` certificado. Expande solo la fase activa; compacta fases cerradas a 1 línea `✅`. Detalle en [`ARCHITECTURE.md`](ARCHITECTURE.md).

## 1. Mapa Ejecutivo de Hitos y Fases

| Hito | Fase | Alcance resumido | Estado |
| --- | --- | --- | :---: |
| **Hito 1 — Go-Live** | **Fase 0 — Fundación, Seguridad y Shell Admin** | Gobernanza (`F0.1`), Monorepo Next 16 (`F0.2`), PG 17 + Prisma `BigInt` + RLS + Bóveda + Outbox (`F0.3`), Auth + Login Admin + **MFA `aal2`** + RBAC 8 roles + PII mask (`F0.4`), CI/Gates (`F0.5`). | `[/]` |
| **Hito 1** | **Fase 1 — Catálogo Tech, Media 360°/3D e Inventario WAC** | `F1.1` Marcas, Categorías N-niveles, Colecciones, Atributos/Facetas (`ADR-008`), GTIN/EAN, Compatibilidad y Bundles · `F1.2` `packages/media` (R2 + AVIF/WebP + Spin 360° + 3D/AR lazy) · `F1.3` Multi-bodega (`safetyStock` efectivo + orden determinista de locks) + Proveedores/WAC + Importador CSV · `F1.4` `CatalogService` único (`'use cache'`), Comparador, PDP, Admin y seed. | `[ ]` |
| **Hito 1** | **Fase 2 — CMS v3, SEO y Legal CO** | `F2.1` Bloques componibles Zod + `StoreSettings` separados + versionado/programación + Mediateca R2 · `F2.2` Live Edit en `<Suspense>` + SERP · `F2.3` `packages/legal-co` (8 docs, Ley 1480/2439 retracto + festivos CO, Ley 1581) + `UrlRedirect` + JSON-LD + Sitemap + Merchant XML (`Brand`/`GTIN`). | `[ ]` |
| **Hito 1** | **Fase 3 — Carrito, Checkout, IVA Dual, Pagos y Logística** | `F3.1` `CartService` (revalidación precios, `WholesaleTier` multi-variante, Bundles, Cupones `BigInt`, Venta Asistida `/pagar/[token]`) · `F3.2` Checkout DANE/Click&Collect + IVA Dual/UVT + `OrderReceipt` (`ADR-010`) + `Shipment`/`OrderRefund` 1:N + `DomainOutbox` · `F3.3` Bóveda `/admin/integraciones` + `PaymentProvider` (`refund()`, Wompi, COD, Transferencia MFA, `StoreCredit`) · `F3.4` Aveonline *pick & pack* asíncrono + Claim Idempotente + multi-bulto + Flex local + Resend/Svix + puerto DIAN. | `[ ]` |
| **Hito 1** | **Fase 4A — Operación, RMA/Seriales y Lanzamiento** | `F4A.1` `/admin/{hoy,dashboard,pedidos,finanzas}` (cuadre total de `OrderRefund`) + Vigilancia `3.500 UVT` · `F4A.2` `/mi-cuenta/*` + Posventa 2FA `/pedido/[token]` + RMA (Retracto parcial, Cambios, Garantía con `SerializedUnit` Serial/IMEI) + PQR SLA + Reseñas con FK · `F4A.3` OWASP + Playwright E2E + `@axe-core` + Lighthouse ≥ 95 + k6 + **Go-Live `mundonettech.co`**. | `[ ]` |
| **Hito 2 — Escala** | **Fase 4B — CRM 360 y Canal B2B** | `F4B.1` `Contact` 360° + duplicados + tareas + retención Hábeas Data · `F4B.2` `PriceList` B2B + `/empresas` → Propuestas `BigInt` `/propuesta/[token]` → `Order` + Copiloto 0-PII. | `[ ]` |
| **Hito 2** | **Fase 5 — Lealtad, Lifecycle y Observabilidad** | `F5.1` Puntos (con reversa `EARN` en reembolso) + Referidos + Carritos abandonados · `F5.2` Lifecycle + Segmentos Ley 1581 + RFM/LTV · `F5.3` Observabilidad desacoplada + Alertas + Backups GPG streaming R2 + DR drill completo (`auth` + todos los buckets) + Ayuda v2. | `[ ]` |
| **Hito 2** | **Fase 6 — Omnicanal ML `MCO` + Meta CAPI** | `F6.1` OAuth PKCE serializado · `F6.2` Legacy/User Products + stock `x-version` + Full + precios `FORMULA`/`MANUAL` (zona muerta \$60k) · `F6.3` `ChannelPack`/`ChannelOrder` + `ME2`/Flex + posventa + conciliación · `F6.4` Meta Catalog + Pixel/CAPI. | `[ ]` |
| **Hito 3 (Opc.)** | **Fase 7 — WhatsApp + Agente IA** | WhatsApp Cloud API (Meta App propia) + Agente Gemini TS sobre `packages/core` + Inbox humano con *takeover*. | `[ ]` |

---

## 2. Fase Activa — Fase 0: Fundación, Seguridad Mandatoria y Shell Admin

- `[x]` ✅ **`F0.1` — Gobernanza, higiene Git y arquitectura viva:** `.gitignore`, `.gitleaks.toml`, `AGENTS.md`, `README.md` y `docs/{INDEX,STATE,PLAN,ARCHITECTURE,DECISIONS}.md`.
- `[x]` ✅ **`F0.2` — Monorepo `pnpm` + Turborepo + Next.js 16 + Tokens Semánticos + Guardas CI:** `@mundonettech/config`, `packages/{db,core,media,cms,integrations,legal-co}`, `apps/web` (`:4010`, `standalone`, `'use cache'`), ESLint (`client-ip`, `sharp-safe`), guardas y tests negativos.
- `[ ]` **`F0.3` — PostgreSQL 17 Local (Podman `:54421..54424`) + Prisma `BigInt` + RLS + Bóveda:**
  - `supabase/config.toml` aislado + **1 sola cadena de migraciones versionada** (`ADR-003`).
  - Modelos base en `packages/db/prisma/schema/` (`AdminUser`, `AdminRecoveryCode`, `AdminActionLog`, `SecurityEvent`, `Customer`, `Consent`, `IntegrationCredential` `AES-256-GCM`, `DomainOutbox`, `IdempotencyKey`) + trigger `enforce_rls_on_new_table` + `REVOKE ALL` PostgREST + `verify-security-posture`.
- `[ ]` **`F0.4` — Seguridad de Borde, Auth Cliente y Núcleo `/admin` con MFA `aal2`:**
  - `proxy.ts` (CSP/headers, anti-race `@supabase/ssr`, timeout HMAC 30 min admin / 30 d cliente).
  - Auth cliente (OTP 6 dígitos, HIBP k-anonymity, anti-enumeración, Turnstile).
  - `/admin/login` + `/admin/login/mfa` (**TOTP `aal2` obligatorio** + códigos HMAC + `requireRecentMfa` ≤ 10 min) + RBAC 8 roles (3 anillos) + `pii-mask.ts` + `AdminShell` + `/admin/{usuarios,seguridad,auditoria}`.
- `[ ]` **`F0.5` — Suite RLS Real, Vitest/Playwright Base, GitHub Actions PG 17 y `OPERATIONS.md`:**
  - Suites contra PG 17 real (bloqueo anti-PRD + `EMAIL_SEND_DISABLED=1`), `rls-matrix`, smoke E2E y `ci.yml` en verde.

---

## 3. Handoff para la siguiente sesión

- **Siguiente bloque:** **`F0.3`** en rama `feat/f0-3-db-rls-vault` desde `develop` (tras fusionar PR de `F0.2`).
- **Leer al iniciar:** `AGENTS.md`, `docs/STATE.md`, `docs/PLAN.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` y `packages/db/README.md`.
- **Cierre dual `F0.3`:** Implementador levanta PG 17 (`_mundonettech` `:54421..54424`), entrega migración única Prisma `BigInt` + RLS + `enforce_rls_on_new_table` + `REVOKE ALL` PostgREST + bóveda `AES-256-GCM` + `verify-security-posture` en `[R]` con `make check && pnpm test && pnpm build` en verde; Auditor certifica `[x]` en PR contra `develop`.
