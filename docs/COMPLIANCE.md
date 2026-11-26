# Cumplimiento Legal Colombia y SEO Técnico — MundoNetTech

> Documento vivo del alcance implementado. No sustituye revisión jurídica ni registra datos empresariales no suministrados. Los textos públicos nacen exclusivamente en `config/legal.config.ts` y se validan con `@mundonettech/legal-co`.

## 1. Documentos públicos y versionado

El centro `/legal` publica ocho documentos con slug, título, resumen, versión semántica, fecha de vigencia, secciones ancladas y fuentes. El contrato exige exactamente estos documentos y bloquea HTML, campos desconocidos, anclas duplicadas, fechas inválidas, correos mal formados y URLs inseguras.

| Documento | Ruta | Materia principal |
| --- | --- | --- |
| Términos y condiciones | `/legal/terminos-y-condiciones` | Identidad disponible, ofertas, pedidos, pagos, entrega y derechos. |
| Aviso de privacidad | `/legal/privacidad` | Datos, finalidades, terceros, seguridad y canal de derechos. |
| Tratamiento de datos personales | `/legal/tratamiento-datos-personales` | Autorización, principios, derechos, conservación y procedimiento. |
| Cookies | `/legal/cookies` | Cookies necesarias, terceros y condiciones para futuras no esenciales. |
| Retracto y devoluciones | `/legal/retracto-y-devoluciones` | Cinco días hábiles, excepciones, devolución, quince días y reversión. |
| Garantías | `/legal/garantias` | Garantía legal/comercial, serial/IMEI, revisión y remedios. |
| Envíos y entregas | `/legal/envios-y-entregas` | Plazo aceptado, treinta días por defecto, retrasos e indisponibilidad. |
| PQR | `/legal/pqrs` | Canales, datos necesarios, constancia y términos de respuesta. |

El footer enlaza el centro legal, retracto, garantías, PQR y la Superintendencia de Industria y Comercio. No se declaran teléfonos, NIT, dirección judicial, coberturas ni cuentas de correo verificadas distintas de las configuradas.

## 2. Consumidor: Leyes 1480 y 2439

- **Retracto:** `calculateRetractWindow` cuenta cinco días hábiles desde la fecha local de entrega. `evaluateRetractWindow` distingue `BEFORE_DELIVERY`, `OPEN` y `CLOSED`, con el día de vencimiento inclusive.
- **Calendario:** `colombianHolidays` calcula los 18 feriados legales por año: seis fijos, siete traslados de la Ley Emiliani, Jueves/Viernes Santo y Ascensión/Corpus/Sagrado Corazón. Las conmemoraciones pueden coincidir en una fecha; el cómputo hábil usa el conjunto de días, no duplica el feriado.
- **Zona horaria:** conversiones a `America/Bogota`; timestamps de texto exigen `Z` u offset explícito. Los cálculos de fecha sola usan UTC para no depender del host.
- **Reembolso por retracto:** máximo quince días calendario desde el ejercicio y el cumplimiento de datos/devolución. `calculateRetractRefundDeadline` suma exactamente quince días en una zona sin DST. La Sentencia C-192 de 2026 mantiene la aplicación uniforme del término en las modalidades del artículo 47.
- **Entrega:** el plazo aceptado debe informarse antes del pago; si no existe, la política documenta treinta días calendario. La implementación transaccional de checkout y envíos está activa desde `F3.2`–`F3.4`.
- **Reversión:** el texto diferencia fraude, operación no solicitada, producto no recibido, distinto o defectuoso y conserva el deber de reclamar al proveedor/emisor dentro de cinco días hábiles.
- **PQR:** el documento define canales y trazabilidad escrita. `F4A.2` implementa radicado persistente con número único, conversaciones append-only, seguimiento web autenticado e invitado, y SLA operativo de 10 días hábiles para consultas/sugerencias y 15 para quejas, reclamos y recursos.

## 3. Ley 1581 de 2012 y Hábeas Data

Las políticas describen finalidades, autorización, excepciones, derechos, datos sensibles, menores, encargados, transferencias, retención y seguridad. Las consultas se documentan con diez días hábiles y los reclamos con quince, incluidas las reglas de información incompleta y prórroga legal.

Controles técnicos activos: RBAC de ocho roles, MFA `aal2` y step-up, RLS *deny-by-default*, PostgREST revocado, bóveda AES-256-GCM, máscaras PII, sesiones HMAC con expiración, `AdminActionLog`, `SecurityEvent` y `Consent` append-only con revocación. La finalidad `ADVERTISING` es independiente de correo/analítica y habilita CAPI únicamente si precede al pago y sigue vigente al despacho; revocar o anonimizar cancela pendientes y elimina hashes de matching. La supresión/anonimización self-service de `/mi-cuenta` está implementada con revocación de sesiones, borrado de direcciones y disociación de identificadores directos. CRM aplica retención de 24 meses con revisión programada y supresión manual Anillo 1 + MFA: bloquea obligaciones abiertas, anonimiza comprador y linaje, elimina identidades directas y redacta actividades, tareas y snapshots conservando únicamente la historia legal/financiera exigida. Los segmentos conservan evidencia append-only de finalidad, consentimiento y métricas; los journeys revalidan autorización y baja antes de cada envío y cancelan inscripciones al revocar, salir del segmento o anonimizar.

Las cookies actuales se documentan como necesarias para Auth, actividad y seguridad; CAPI opera entre servidores sin píxel ni cookies publicitarias. La finalidad y tercero Meta están publicados en la versión 1.1.0 de privacidad/tratamiento. El alta `ADVERTISING` es opcional en checkout y perfil, y cualquier futura cookie analítica/publicitaria no esencial exigirá actualizar inventario, finalidad, duración, terceros y consentimiento antes de activarse.

## 4. Régimen tributario y comprobantes

La configuración inicia en `NO_RESPONSABLE_IVA` con vigilancia de `3.500 UVT` y valor UVT configurable (año 2026: **$52.374 COP**, Resolución DIAN 000238 de 2025). `F3.2` ya implementa el cambio a `RESPONSABLE_IVA`, topes tech `50`/`22 UVT` por unidad neta, `OrderItemTaxLine[]` selladas y `OrderReceipt` no fiscal verificado. El recibo distingue pedido registrado de pago pendiente y no equivale a factura electrónica; mientras `paymentStatus = UNPAID`, la aceptación definitiva queda sujeta a validación de pago, inventario y condiciones de la operación. `F3.4` incorpora `InvoiceProvider` DIAN UBL 2.1, Notas Crédito vinculadas a facturas aceptadas y reembolsos ejecutados, numeración serializada, CUFE/CUDE y aceptación exclusiva de XML firmado por el proveedor autorizado. La habilitación, los certificados y la validación externa con el proveedor y la DIAN siguen siendo requisitos operativos antes de Go-Live.

El checkout valida en PostgreSQL la DIVIPOLA oficial DANE con corte al 30 de diciembre de 2024 (`33` departamentos y `1.122` municipios/áreas), sin depender de llamadas externas en tiempo de compra. Aceptación de términos/privacidad, promesa de entrega, snapshots DANE, régimen y UVT quedan persistidos por orden.

Las propuestas B2B sellan por versión los importes `BigInt`, descuentos, régimen/UVT, impuestos duales y flete antes de su aceptación. La firma conserva prueba hash y documentos DIAN separados para empresa y firmante; convertir crea un pedido `UNPAID` y su recibo no fiscal, no una factura ni una confirmación de pago. Retención elimina notas y firmantes sin modificar importes ni historia financiera.

Todos los importes de catálogo, JSON-LD y Merchant XML parten de centavos `BigInt` serializados como strings. La conversión a decimal conserva los dos dígitos sin floats.

## 5. Redirecciones y SEO técnico

- `UrlRedirectService` y el resolvedor de `proxy.ts` comparten la lista canónica de `@mundonettech/core`, serializan mutaciones con advisory lock, bloquean orígenes en `/` o rutas reservadas (`/api`, `/_next`, `/_not-found`, `/admin`, `/email`, `/mi-cuenta`, auth, `/legal`, `/ayuda`, `/robots.txt`, `/sitemap.xml`, `/sitemaps`, `/carrito`, `/checkout`, `/recibo`, `/pagar`, `/pedido`, `/referido`, `/propuesta`, `/empresas`, `/productos`, `/comparar`) y destinos internos (`/api`, `/_next`, `/_not-found`, `/admin`, `/email`, `/referido`), validan estados `301/302/307/308`, ciclos y máximo 100 saltos, auditan y permiten recrear orígenes archivados.
- `proxy.ts` resuelve cadenas únicamente en peticiones `GET`/`HEAD` sin `next-action` ni Live Edit sobre una caché validada contra la generación monotónica compartida `UrlRedirectCacheState.version` en PG 17 (incrementada transaccionalmente en cada mutación, con deduplicación de cargas concurrentes y reintentos ante cambios en vuelo). Los destinos públicos conservan el query original.
- JSON-LD: `Organization`, `WebSite`, `Product`, `Offer`, `BreadcrumbList` (catálogo y centro legal) y `FAQPage` visible. No se generan reseñas, ratings ni disponibilidad ficticias. La PLP conserva su encabezado en el shell PPR, la PDP prerenderiza hasta 48 productos activos y la metadata dinámica se resuelve dentro de `head` para todos los clientes (`htmlLimitedBots=/.*/`), sin variantes especiales para bots de medición.
- `/robots.txt` autoriza explícitamente `/api/feeds/` mientras bloquea `/api/` y rutas privadas, y referencia `/sitemap.xml`; el sitemap incluye catálogo, marcas, categorías, CMS publicado (`lastmod` sincronizado con la última versión publicada), legales, `/ayuda` + `/ayuda/[slug]`, `/comparar` y `/empresas`. Superadas 50.000 URLs, la raíz se convierte en índice y `/sitemaps/[id].xml` entrega particiones.
- `/api/feeds/google-merchant` (`x-robots-tag: noindex`) genera RSS 2.0 con namespace Google, una entrada por variante elegible (`priceCents > 0` e imagen obligatoria de variante o producto), `g:id`, `g:item_group_id`, título, descripción, enlace de variante, precio COP, disponibilidad, marca, GTIN comercial (`8/12/13/14` dígitos GS1, excluyendo SSCC-18 logísticos) o MPN y peso. Los productos sin identificadores usan `identifier_exists=no`; no se inventan imágenes ni GTIN.
- `/api/feeds/meta-catalog` (`x-robots-tag: noindex`, `nosniff`) genera CSV por variante con imagen pública obligatoria, enlaces seguros, precio COP decimal exacto, inventario, marca, GTIN/MPN y peso reales. Las variantes inelegibles se excluyen con diagnóstico en `/admin/integraciones`; no se fabrican imágenes, identificadores ni stock. CAPI envía `Purchase` solo con `ADVERTISING`, deduplica `event_id`, purga hashes y exige conciliación MFA ante incertidumbre.

## 6. Pendientes empresariales antes de Go-Live

1. Registrar y verificar razón social, NIT, dirección de notificación judicial, teléfono y demás datos exigidos por el artículo 50; no se rellenan con valores ficticios.
2. Verificar operación y custodia de `servicioalcliente@mundonettech.co` y `privacidad@mundonettech.co`, además de los procedimientos humanos de respuesta y radicación.
3. Someter los ocho textos a revisión jurídica colombiana y actualizar versión/vigencia ante cambios.
4. Contratar y verificar en ambiente real las pasarelas de pago, Aveonline, Resend y el proveedor autorizado DIAN, incluidos certificados, resolución y credenciales; ejecutar las compuertas de lanzamiento `STG`/`PRD` (`release:verify` + evidencia humana en `M2`/`M3`). RMA/PQR web, anonimización self-service y gates locales ya están certificados (`F0`–`F6` y `A1`–`A10`), pero la integración técnica local no equivale a habilitación tributaria ni a certificación de los servicios externos.
5. Configurar en Merchant Center envío, impuestos y políticas de la cuenta; el feed no inventa tarifas logísticas. Provisionar el píxel/catálogo de Meta y el token del sistema con permisos mínimos, registrar el feed en Commerce Manager y verificar recepción/deduplicación en Events Manager antes de attestar `RELEASE_META_VERIFIED`; la integración local no acredita esos servicios externos.

## 7. Fuentes oficiales de referencia

- [Ley 1480 de 2011 — Estatuto del Consumidor](https://www.secretariasenado.gov.co/senado/basedoc/ley_1480_2011.html), especialmente artículos 47, 50, 51 y 58.
- [Ley 2439 de 2024 — comercio electrónico](https://www.secretariasenado.gov.co/senado/basedoc/ley_2439_2024.html), artículos 3 y 4.
- [Sentencia C-192 de 2026](https://www.secretariasenado.gov.co/senado/basedoc/c-192_2026.html), término uniforme de quince días para retracto.
- [Ley 1581 de 2012 — protección de datos personales](https://www.secretariasenado.gov.co/senado/basedoc/ley_1581_2012.html).
- [Superintendencia de Industria y Comercio](https://www.sic.gov.co/).
