# `@mundonettech/cms`

CMS v3 con persistencia PostgreSQL 17, bloques componibles Zod y operaciones editoriales/administrativas. La configuración operativa permanece separada del contenido editorial (`ADR-016`).

## Contratos

- Seis bloques estrictos: `HERO`, `RICH_TEXT`, `IMAGE`, `CTA`, `PRODUCT_GRID` y `FAQ`. No se aceptan campos desconocidos, HTML arbitrario, enlaces `javascript:`/ambiguos ni estructuras fuera de esquema.
- `interpolateCmsText` y `renderCmsBlock` resuelven únicamente tokens conocidos como `{{store.name}}`; tokens desconocidos o expresiones incompletas se rechazan antes de guardar o publicar.
- `CmsService` crea páginas/bloques, mantiene versiones consecutivas bajo locks, reordena sin colisiones, controla visibilidad y publica inmediatamente o por fecha. El contenido/versionado histórico es inmutable en PostgreSQL.
- `getPublishedPage` selecciona la última versión `PUBLISHED` con `effectiveAt` vigente por bloque visible. El job `publishScheduled` usa reloj PG y difiere páginas sin bloques vigentes; `apps/web` expone el endpoint autenticado `/api/jobs/cms-publish`.
- `StoreSettingsService` persiste régimen IVA, alerta UVT, moneda, zona IANA, consecutivo y flags logísticos sin mezclarlos con contenido ni secretos.
- `CmsMediaService` procesa imágenes mediante `sharp-safe`, almacena derivados AVIF/WebP en R2 con claves content-addressed, deduplica por SHA-256, registra dimensiones/derivados y limpia objetos nuevos si falla la transacción. No archiva medios referenciados por el historial editorial.
- Toda mutación escribe `AdminActionLog`; las superficies `/admin/contenido`, `/admin/contenido/medios` y `/admin/configuracion` aplican RBAC, `aal2` y MFA reciente.
