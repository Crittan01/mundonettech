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
- **Entrega:** el plazo aceptado debe informarse antes del pago; si no existe, la política documenta treinta días calendario. La implementación transaccional de checkout y envíos pertenece a `F3.2`–`F3.4`.
- **Reversión:** el texto diferencia fraude, operación no solicitada, producto no recibido, distinto o defectuoso y conserva el deber de reclamar al proveedor/emisor dentro de cinco días hábiles.
- **PQR:** el documento define canales y trazabilidad escrita. El radicado automático con seguimiento web y SLA operativo se completa en `F4A.2`; no se simula en esta fase.

## 3. Ley 1581 de 2012 y Hábeas Data

Las políticas describen finalidades, autorización, excepciones, derechos, datos sensibles, menores, encargados, transferencias, retención y seguridad. Las consultas se documentan con diez días hábiles y los reclamos con quince, incluidas las reglas de información incompleta y prórroga legal.

Controles técnicos activos: RBAC de ocho roles, MFA `aal2` y step-up, RLS *deny-by-default*, PostgREST revocado, bóveda AES-256-GCM, máscaras PII, sesiones HMAC con expiración, `AdminActionLog`, `SecurityEvent` y `Consent` append-only con revocación. La supresión/anonimización self-service de `/mi-cuenta` y la retención CRM completa se certifican en fases posteriores; no se afirman como ya entregadas.

Las cookies actuales se documentan como necesarias para Auth, actividad y seguridad. Cualquier analítica/publicidad no esencial exige actualizar inventario, finalidad, duración, terceros y consentimiento antes de activarse.

## 4. Régimen tributario y comprobantes

La configuración inicia en `NO_RESPONSABLE_IVA` con vigilancia de `3.500 UVT`. El cambio a `RESPONSABLE_IVA`, topes tech `50`/`22 UVT`, cierre de impuestos por `OrderItemTaxLine`, `OrderReceipt`, DIAN UBL 2.1 y Notas Crédito pertenecen a `F3.2`–`F3.4`. Los documentos legales no afirman que esas capacidades futuras estén operativas.

Todos los importes de catálogo, JSON-LD y Merchant XML parten de centavos `BigInt` serializados como strings. La conversión a decimal conserva los dos dígitos sin floats.

## 5. Redirecciones y SEO técnico

- `UrlRedirectService` serializa mutaciones con advisory lock, bloquea orígenes en `/` o rutas reservadas (`/api`, `/_next`, `/admin`, `/mi-cuenta`, auth, `/legal`, `/robots.txt`, `/sitemap.xml`, `/sitemaps`, `/checkout`, `/pagar`, `/pedido`, `/propuesta`) y destinos internos (`/api`, `/_next`, `/admin`), valida estados `301/302/307/308`, ciclos y máximo 100 saltos, audita y permite recrear orígenes archivados.
- `proxy.ts` resuelve cadenas únicamente en peticiones `GET`/`HEAD` sin `next-action` ni Live Edit sobre una caché global con TTL de treinta segundos, deduplicación de carga e invalidación explícita más `revalidatePath` desde acciones. Los destinos públicos conservan el query original.
- JSON-LD: `Organization`, `WebSite`, `Product`, `Offer`, `BreadcrumbList` (catálogo y centro legal) y `FAQPage` visible. No se generan reseñas, ratings ni disponibilidad ficticias.
- `/robots.txt` autoriza explícitamente `/api/feeds/` mientras bloquea `/api/` y rutas privadas, y referencia `/sitemap.xml`; el sitemap incluye catálogo, marcas, categorías, CMS publicado (`lastmod` sincronizado con la última versión publicada) y legales. Superadas 50.000 URLs, la raíz se convierte en índice y `/sitemaps/[id].xml` entrega particiones.
- `/api/feeds/google-merchant` (`x-robots-tag: noindex`) genera RSS 2.0 con namespace Google, una entrada por variante, `g:id`, `g:item_group_id`, título, descripción, enlace de variante, imagen propia de la variante o del producto si existe, precio COP, disponibilidad, marca, GTIN comercial (`8/12/13/14` dígitos GS1, excluyendo SSCC-18 logísticos) o MPN y peso. Los productos sin identificadores usan `identifier_exists=no`; no se inventan imágenes ni GTIN.

## 6. Pendientes empresariales antes de Go-Live

1. Registrar y verificar razón social, NIT, dirección de notificación judicial, teléfono y demás datos exigidos por el artículo 50; no se rellenan con valores ficticios.
2. Verificar operación y custodia de `servicioalcliente@mundonettech.co` y `privacidad@mundonettech.co`, además de los procedimientos humanos de respuesta y radicación.
3. Someter los ocho textos a revisión jurídica colombiana y actualizar versión/vigencia ante cambios.
4. Completar checkout, comprobante no fiscal, RMA/PQR web, retención self-service, integraciones y pruebas de lanzamiento de sus fases correspondientes.
5. Configurar en Merchant Center envío, impuestos y políticas de la cuenta; el feed no inventa tarifas logísticas.

## 7. Fuentes oficiales de referencia

- [Ley 1480 de 2011 — Estatuto del Consumidor](https://www.secretariasenado.gov.co/senado/basedoc/ley_1480_2011.html), especialmente artículos 47, 50, 51 y 58.
- [Ley 2439 de 2024 — comercio electrónico](https://www.secretariasenado.gov.co/senado/basedoc/ley_2439_2024.html), artículos 3 y 4.
- [Sentencia C-192 de 2026](https://www.secretariasenado.gov.co/senado/basedoc/c-192_2026.html), término uniforme de quince días para retracto.
- [Ley 1581 de 2012 — protección de datos personales](https://www.secretariasenado.gov.co/senado/basedoc/ley_1581_2012.html).
- [Superintendencia de Industria y Comercio](https://www.sic.gov.co/).
