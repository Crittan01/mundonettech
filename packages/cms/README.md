# `@mundonettech/cms`

CMS v3 con persistencia PostgreSQL 17, bloques componibles Zod y operaciones editoriales/administrativas. La configuración operativa permanece separada del contenido editorial (`ADR-016`).

## Contratos

- Seis bloques estrictos: `HERO`, `RICH_TEXT`, `IMAGE`, `CTA`, `PRODUCT_GRID` y `FAQ`. No se aceptan campos desconocidos, etiquetas/comentarios HTML arbitrarios, caracteres de control, enlaces `http:`/`javascript:`/con credenciales ni estructuras fuera de esquema.
- `interpolateCmsText` y `renderCmsBlock` resuelven únicamente tokens conocidos como `{{store.name}}`; tokens desconocidos, valores con HTML o expresiones incompletas se rechazan antes de guardar o publicar.
- `CmsService` crea páginas/bloques (tope 100 por página), bloquea `CmsMedia` con `FOR SHARE` contra archivo concurrente, mantiene versiones consecutivas bajo locks, reordena atómicamente bajo `FOR UPDATE` en `CmsPage`, controla visibilidad y publica inmediatamente o por fecha. El historial de versiones es inmutable en PostgreSQL.
- `getPublishedPage` selecciona la última versión `PUBLISHED` con `effectiveAt` vigente por bloque visible. El job `publishScheduled` usa reloj PG, excluye páginas eliminadas, difiere páginas sin bloques vigentes y reporta `affectedSlugs` para expiración inmediata de caché en `/api/jobs/cms-publish`.
- `StoreSettingsService` persiste régimen IVA, alerta UVT, moneda ISO 4217, zona IANA en paridad con PG 17, consecutivo y flags logísticos bajo advisory lock sin mezclarlos con contenido ni secretos.
- `CmsMediaService` procesa imágenes mediante `sharp-safe`, almacena derivados AVIF/WebP en R2 content-addressed, deduplica por SHA-256, limpia objetos sin propietario ante fallo DB (preservando objetos compartidos con activos archivados) y bloquea en SQL/servicio el archivo o borrado de medios referenciados por `CmsBlockVersion`.
- Toda mutación escribe `AdminActionLog`; `/admin/contenido`, `/admin/contenido/medios` y `/admin/configuracion` aplican RBAC, `aal2`, MFA reciente, máscara PII server-side y preservación de formularios ante error.
