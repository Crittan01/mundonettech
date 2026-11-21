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
- `getPublishedPage` devuelve DTO serializables con la versión pública vigente y sus medios; `getPreviewPage` incluye últimas versiones, borradores, bloques ocultos y `sourceContent` con tokens originales. Toda llamada al preview exige autorización en la superficie web.
- `/pagina/[slug]` renderiza los seis bloques con `'use cache'`, tags editoriales/de catálogo y Partial Prerendering. En `PRODUCT_GRID`, `productSlugs` define una selección curada ordenada; si está vacía, `categorySlug` y `maxItems` alimentan la selección automática.
- `/pagina/[slug]?liveEdit=1` aísla autenticación `aal2` + `content:write` en `<Suspense>`, usa `noindex`, conserva tokens al editar y redirige tras cambiar el slug. Las mutaciones mantienen MFA reciente e invalidación de tags.
- `buildCmsSeo` genera canonical `/pagina/{slug}`, SERP, OpenGraph (`es_CO`) y Twitter Card; la primera imagen editorial visible alimenta la tarjeta social. El formulario muestra una vista previa controlada sin truncar el contenido persistido.
