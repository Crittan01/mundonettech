# `@mundonettech/media`

Pipeline multimedia productivo para Cloudflare R2 y visores 360°/3D/AR de carga diferida. Solo `src/sharp-safe.ts` puede importar `sharp`; el resto del monorepo consume las funciones exportadas por este paquete.

## Imágenes

- `inspectImageMagic()` exige magic bytes JPEG, PNG, WebP, AVIF o HEIC. Rechaza SVG y formatos desconocidos, limita la entrada a 20 MiB, 40 millones de píxeles y 12 000 píxeles por lado, y comprueba recursivamente la caja `ispe` de AVIF/HEIC antes de decodificar.
- `processImageSafely()` vuelve a verificar las dimensiones decodificadas, auto-rota la orientación y genera AVIF y WebP en sRGB. Elimina EXIF, IPTC, XMP y GPS, y verifica los metadatos de cada salida.
- Los anchos solicitados se deduplican, no amplían la imagen y siempre incluyen el ancho original. Los anchos deben ser enteros entre 32 y 8192 píxeles; los valores predeterminados son 480, 768, 1280 y 1920.

## Persistencia en R2

`R2MediaStorage` usa el AWS SDK compatible con S3, `region: auto` y *path-style*. Exige HTTPS salvo endpoints loopback para pruebas, valida bucket y metadatos, sube hasta 8 MiB con `PutObject` y archivos mayores con multipart de 8 MiB. `publicBaseUrl` es opcional; las credenciales deben llegar desde la configuración segura del ambiente, nunca desde el navegador.

`storeImageDerivatives()`, `storeSpin360()` y `storeModel3d()` generan claves normalizadas con SHA-256 del original y cache inmutable. Si un paso falla, eliminan los objetos ya escritos; si también falla la limpieza, propagan un `AggregateError` con ambas causas. La reanudación de una secuencia interrumpida vuelve a escribir las mismas claves dirigidas por contenido.

```ts
const derivatives = await storeImageDerivatives(storage, input, "products/<product-id>", [
  480, 768, 1280,
]);
const frames = await storeSpin360(storage, orderedFrames, "products/<product-id>/spin");
const model = await storeModel3d(storage, glb, "glb", "products/<product-id>/model");
```

## Modelos y visores

- `validateGlb()` admite GLB 2 con JSON y un único chunk BIN; exige recursos embebidos y rangos de buffers/vistas válidos, con máximo 50 MiB.
- `validateUsdz()` recorre y descomprime en streaming un ZIP de máximo 25 MiB. Exige exactamente un payload USDA/USDC, permite texturas PNG/JPEG, bloquea cifrado, traversal, tipos desconocidos y desbordes de tamaño, cantidad o ratio de compresión.
- `Spin360` renderiza solo el frame actual, permite arrastre, teclado y botones, y precarga el vecino bajo interacción. Requiere de 2 a 120 frames en el pipeline y muestra estados de carga y error accesibles.
- `Model3d` no carga `@google/model-viewer`, GLB ni USDZ hasta que el usuario pulsa «Explorar en 3D». Incluye poster, reintento y AR con `ios-src` cuando existe USDZ.
- Los componentes usan `next/image` con `unoptimized`, ya que este paquete genera previamente los derivados responsivos. Las URL públicas deben estar permitidas por la configuración de imágenes del consumidor.

`ProductMedia.frames` conserva el arreglo ordenado de derivados para `SPIN_360` y PostgreSQL exige que su longitud coincida con `frameCount`. `posterKey` identifica de forma única el poster activo; la FK compuesta `(variantId, productId)` impide asociar medios a una variante de otro producto.
