# MundoNetTech (`mundonettech.co`)

Plataforma de comercio electrónico **100 % productiva** de tecnología, wearables, audio, carga rápida y accesorios multimarca en Colombia, diseñada con arquitectura modular, exactitud financiera en `BigInt`, seguridad de cuatro capas desde Fase 0 y operación omnicanal.

## Stack principal

- **Aplicación y UI:** Next.js 16 (`App Router`, `RSC`, `Server Actions`, `proxy.ts`, `'use cache'`, `output: "standalone"`), React 19, TypeScript strict (`noUncheckedIndexedAccess`), Tailwind CSS v4 (tokens CSS semánticos), shadcn/ui + Radix.
- **Monorepo:** `pnpm` workspaces + Turborepo (`apps/web`, `config/`, `packages/{db,core,media,cms,integrations,legal-co}`).
- **Datos y Auth:** PostgreSQL 17 (Supabase) + Prisma multi-file (una única cadena de migraciones versionada), 100 % RLS *deny-by-default* con trigger DDL automático, Supabase Auth (OTP de 6 dígitos + MFA TOTP `aal2` obligatorio en `/admin`).
- **Medios y Respaldos:** Cloudflare R2 (`$0` egress; derivados AVIF/WebP + Spin 360° + modelos 3D PBR/AR `.glb`/`.usdz` + respaldos diarios cifrados GPG AES-256 en streaming).
- **Operación Comercial en Colombia:** Wompi + Contraentrega (COD) + Transferencia verificada con MFA, Aveonline + Mensajería Flex local, Resend (puerto `EmailProvider`), Mercado Libre `MCO` + Meta CAPI, cumplimiento Ley 1480/2439 + Ley 1581 + Motor Tributario Dual IVA / DIAN.

## Puertos de desarrollo local

| Servicio local | Puerto | Propósito |
| --- | --- | --- |
| Next.js dev / start | `:4010` (`:4110` E2E) | Storefront, Checkout, Mi Cuenta, Admin y APIs |
| Supabase API (Kong) | `:54421` | Auth SSR y Storage local (`project_id = "mundonettech"`) |
| PostgreSQL 17 | `:54422` | Instancia local en Podman rootless |
| Supabase Studio | `:54423` | Consola local de base de datos |
| Mailpit | `:54424` | Bandeja local para códigos OTP y correos de prueba |

## Documentación y flujo de trabajo

Toda la documentación es **viva, concisa y libre de bitácoras históricas**. Consulta el índice completo en [`docs/INDEX.md`](docs/INDEX.md).
- **Asistentes de IA:** iniciar siempre leyendo [`AGENTS.md`](AGENTS.md) → [`docs/STATE.md`](docs/STATE.md) → [`docs/PLAN.md`](docs/PLAN.md).
