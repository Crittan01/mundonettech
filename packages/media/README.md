# `@mundonettech/media`

Pipeline multimedia productivo para Cloudflare R2 y visores 360°/3D/AR de carga diferida. Solo `src/sharp-safe.ts` puede importar `sharp` (regla ESLint `foundation/sharp-safe`); los componentes cliente se exponen además en `@mundonettech/media/viewers` sin dependencias de servidor (`sharp`, `@aws-sdk/*`, `yauzl` ni `node:*`).

## Seguridad e Imágenes (`sharp-safe`)

- En `sharp-safe.ts`, `sharp.block({ operation: ["VipsForeignLoad"] })` + `sharp.unblock(...)` restringe `libvips` en C exclusivamente a `JpegBuffer`, `PngBuffer`, `WebpBuffer` y `HeifBuffer`, bloqueando SVG, PDF, TIFF, GIF, Magick, JP2K, Raw y todo cargador `*File`.
- `inspectImageMagic()` verifica magic bytes JPEG, PNG (`IHDR`), WebP (`VP8X`), AVIF y HEIC (`ftyp` + `compatible_brands` + caja estándar `ispe` con profundidad y conteo acotados), limitando entradas a 20 MiB, 40 MP y 12 000 px por lado antes de decodificar.
- `processImageSafely()` decodifica una sola página (`pages: 1`), valida coincidencia de formato, corrige ejes transpuestos por orientación EXIF (`5..8`) antes de deduplicar anchos `[480, 768, 1280, 1920]` + ancho original sin ampliar (`32..8192` px), convierte a sRGB en AVIF y WebP, purga EXIF/IPTC/XMP/Photoshop/GPS y reverifica cada derivado.

## Persistencia en R2

`R2MediaStorage` usa AWS SDK S3 (`region: auto`, *path-style*), exige HTTPS salvo loopback en pruebas, sube objetos `<= 8 MiB` con `PutObject` y mayores con multipart de 8 MiB (`leavePartsOnError: false`). `storeImageDerivatives()`, `storeSpin360()` (`2..120` frames) y `storeModel3d()` validan prefijos antes de decodificar, generan claves SHA-256 inmutables y ejecutan rollback completo ante fallos parciales (propagando `AggregateError` con todas las causas si falla también el borrado).

`ProductMediaService` conecta esos pipelines con `ProductMedia` para imágenes, secuencias 360° y modelos GLB/USDZ. Valida producto/variante, límites tempranos y texto alternativo; serializa posiciones mediante el bloqueo del producto, deduplica asociaciones activas, escribe `AdminActionLog` en la misma transacción con `before/after` allowlisted y `sanitizeAuditValue` (estados, IDs, posiciones y conteos; nunca claves R2 ni texto alternativo) y compensa en R2 únicamente grupos sin referencias activas o archivadas. `POST /api/admin/catalog-media/upload` exige `catalog:write` + MFA reciente y Origin estricto antes de leer el body o inicializar R2, aplica streaming multipart con límites reales (20 MiB/imagen, 100 MiB/secuencia, 50 MiB/GLB y 25 MiB/USDZ) y conserva `requestId`, dedupe, locks, compensación e invalidación tras commit. El archivado y la edición de alt/posición siguen como Server Actions de metadata separadas.

## Modelos 3D/AR y Visores (`@mundonettech/media/viewers`)

- `validateGlb()` exige GLB 2.0 (`asset.version` `2.x`), alineación de 4 bytes en `JSON`/`BIN`, cero `uri` externas en todo el árbol JSON, rechazo de `KHR_draco_mesh_compression`/`EXT_meshopt_compression` (sin decodificadores WASM externos bajo CSP) y vistas/accesores/texturas embebidas válidas (`<= 50 MiB`).
- `validateUsdz()` inspecciona en streaming archivos `.usdz` (`<= 25 MiB`, `<= 100 MiB` descomprimido, ratio `<= 200`): exige etapa raíz `.usdc`/`.usda` como primera entrada, bloquea cifrado, *symlinks* ZIP, rutas ocultas/traversal o archivos sin extensión, y verifica magic bytes reales en cada textura embebida.
- `buildPictureSources()` y `buildSpinFrames()` transforman derivados almacenados en `<source type="image/avif">` + `<source type="image/webp">` con URLs validadas (`isSafeMediaUrl`).
- `Spin360` renderiza solo el frame activo (`next/image` `unoptimized`), soporta arrastre, botones y teclado completo (`ArrowLeft`/`Down`, `ArrowRight`/`Up`, `Home`, `End`), mantiene regiones `status`/`alert` fuera de `role="slider"` y precarga vecinos deduplicados.
- `Model3d` difiere `@google/model-viewer`, `.glb` y `.usdz` hasta pulsar «Explorar en 3D», incluye *timeout*, reintento, retorno a poster y AR (`webxr`/`scene-viewer` + `quick-look` con `ios-src`).
- En PostgreSQL 17, `ProductMedia` exige longitud `2..120` y elementos válidos en `frames` (`SPIN_360`), claves seguras sin traversal, `usdzKey` exclusiva de `MODEL_3D` e índices únicos parciales activos sobre `storageKey`, `posterKey` y `usdzKey`.
