# `@mundonettech/integrations`

Puertos desacoplados de integraciones y bóveda operativa de credenciales. No contiene secretos, identidad visual ni credenciales de ejemplo en código productivo.

## Bóveda AES-256-GCM

`IntegrationCredentialVault` persiste credenciales mediante `@mundonettech/db` y ofrece creación, revelado, rotación, recifrado con la clave activa, revocación y listado paginado. Los descriptores nunca incluyen `nonce`, `ciphertext` ni `authTag`. Toda mutación registra `AdminActionLog` (incluyendo `requestId`, `ipHash` y `userAgentHash` opcionales) en la misma transacción y usa el `nonce` previo como token optimista de concurrencia.

- Claves de 32 bytes, nonce aleatorio de 12 bytes y tag de 16 bytes; plaintext limitado a 64 KiB.
- AAD vinculado criptográficamente a ambiente, UUID, `provider` y `accountName` de la credencial. Los llaveros `LOCAL`, `STG` y `PRD` se cargan por variables independientes y no pueden descifrar ni listar datos de otro ambiente.
- Las versiones antiguas permanecen disponibles para descifrar; solo la versión activa cifra. Los errores nunca exponen claves ni plaintext.

Configura `INTEGRATION_CREDENTIAL_KEYS_<AMBIENTE>` como JSON `{ "1": "base64-de-32-bytes" }` e `INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_<AMBIENTE>`, generadas con `openssl rand -base64 32` en el gestor de secretos de cada ambiente.


## Pagos agnósticos y Wompi

`PaymentService` inicia intentos sobre el saldo no comprometido de una orden (expirando automáticamente intentos previos vencidos sin captura y permitiendo reanudar checkouts Wompi vigentes con `resumeWompiCheckout`) y ofrece Wompi, COD, transferencia y crédito de tienda. `PaymentRefundService` ejecuta reembolsos y anulaciones con preparación persistente previa a cada efecto externo; un timeout queda incierto y exige conciliación con evidencia, mientras que rechazos HTTP deterministas marcan `FAILED` (cancelándose al ejecutar un `OrderRefund`). `WompiWebhookService` enruta cuentas múltiples por `reference` y comparte la máquina de estados entre eventos firmados y consultas autenticadas acotadas por orden.

- Wompi usa Web Checkout con firma SHA-256 de referencia, centavos, moneda y expiración. El navegador recibe solo la URL pública firmada; llaves privadas y secretos permanecen en la bóveda. Los webhooks validan propiedades variables, timestamp, ambiente y checksum, y persisten su hash sin almacenar PII.
- COD consulta y bloquea identidades por HMAC (`BlockedIdentityService.isBlocked`) antes de comprometer stock y solo captura cuando lo esperado, recaudado y remitido coinciden. Las discrepancias se conservan y pueden corregirse en una nueva remesa.
- Transferencia requiere confirmación MFA de un actor financiero y una referencia bancaria única. Las instrucciones públicas se habilitan con `BANK_TRANSFER_INSTRUCTIONS`; si no están configuradas, el método no aparece.
- `StoreCreditAccount` y `StoreCreditEntry` mantienen saldos disponible/retenido, versiones monotónicas y una secuencia por cuenta. `HOLD`, `CAPTURE`, `RELEASE` y `REFUND` se validan como cadena en PostgreSQL y la primitiva serializa por cliente antes de bloquear la cuenta, evitando deadlocks entre pagos y ajustes concurrentes.
- Toda captura total descuenta inventario reservado una única vez, acumula `EARN`/bonos de referido en la misma transacción y emite outbox sin PII. Todo reembolso completado o anulación (`VOID`) capturada revierte proporcionalmente esos puntos antes de actualizar el estado agregado, sin superar las capturas disponibles.

`INTEGRATION_ENVIRONMENT` selecciona `LOCAL`, `STG` o `PRD` (con inferencia segura de Vercel). Wompi exige llaves `test` fuera de PRD y `prod` en PRD. Los proveedores HTTP no reintentan automáticamente resultados inciertos y validan tamaño, esquema, importe y referencias de cada respuesta.

## Logística asíncrona y Flex

`ShippingService` crea fulfillments solo tras pago o con COD abierto, valida alistamiento y empaqueta cada unidad exactamente una vez con valor declarado `BigInt`. `AveonlineShippingProvider` autentica y genera una guía por bulto con `dsreferencia` determinista; el claim persistente impide dobles emisiones concurrentes y un timeout pasa a `RECONCILING`, donde `findLabel` debe confirmar existencia o ausencia antes de cualquier reintento. `FlexShippingProvider` emite referencias locales deterministas y el conductor queda sellado al despachar.

Antes del despacho, `assignSerialUnits` o `markShipped` con `serialUnitIds` exige unidades `SOLD` de la misma orden, bodega y variante, con cantidades exactas agregadas por variante. La asignación `SerializedUnit.shipmentId` se bloquea contra carreras, se audita y solo puede modificarse antes del despacho; PostgreSQL vuelve a validar la cobertura al cambiar de estado.

Las credenciales `aveonline` contienen usuario, clave, empresa, remitente y endpoints oficiales de autenticación/generación/consulta; se almacenan exclusivamente en la bóveda. `/admin/logistica` opera con `fulfillment:*` + MFA y permite multi-bulto, conciliación, despacho, entrega y zonas Flex. `LocalDeliveryZone` conserva polígonos enteros E6, DANE, tarifa y corte; checkout recotiza en servidor y sella zona/coordenadas/promesa.

## Resend, Svix y baja RFC 8058

`EmailService` versiona plantillas, congela asunto/HTML/texto/variables por evento y reutiliza la misma clave idempotente de Resend en reintentos. `lifecycle.campaign` exige el snapshot sellado del paso y la relación `LifecycleMessage`, sin permitir overrides editoriales posteriores. Los eventos Svix se verifican con HMAC y ventana anti-replay, deduplican `svix-id` y solo avanzan la jerarquía de entrega. Rebotes y quejas crean supresión por destinatario/tema y cancelan los pasos lifecycle restantes; `/email/baja/[token]` acepta `POST` RFC 8058 sin cookies ni redirección y el token HMAC solo se guarda como hash. Antes de cada envío vuelve a comprobar supresión, consentimiento, membresía y estado del journey; para `cart.recovery` también exige carrito activo, misma actividad y cliente vigentes, bloqueando reintentos ya obsoletos.

La credencial `resend` contiene API key, remitente, endpoint, secreto Svix y secreto HMAC de baja en la bóveda. `EMAIL_SEND_DISABLED=1` bloquea todo envío externo antes del fetch. `/admin/comunicaciones` usa `communications:*` + MFA y enmascara destinatarios.

## Factura electrónica DIAN

`InvoiceService` serializa consecutivos por resolución, sella el régimen IVA del comprador, genera UBL 2.1 con CUFE/CUDE SHA-384 y montos enteros COP, y solo acepta documentos cuando el proveedor autorizado devuelve XML firmado y el identificador coincide. `DianInvoiceProvider` transmite y consulta por CUFE/CUDE; claims y estados `TRANSMITTING`/`UNCERTAIN` evitan doble transmisión. Las notas crédito se vinculan a factura aceptada y reembolso completado con cuadre diferido en PG17, incluidos casos de flete sin productos.

La credencial `dian` incluye token, endpoint del proveedor autorizado, identidad/DANE del emisor, software y resolución vigente; nunca se fabrican esos datos. `/admin/facturacion` usa `invoices:*` + MFA, auditoría transaccional y máscaras de PII. `/api/recibos/[token]/documentos/[kind]/[id]` entrega XML aceptado con el token del recibo, `no-store` y `nosniff`.

## Gemini y Copiloto B2B 0-PII

`GeminiB2bCopilot` consume el endpoint oficial `generateContent` con la llave en `x-goog-api-key`, timeout y respuesta limitada. El request contiene exclusivamente estados y agregados de cantidades/importes/vigencia; nunca IDs, nombres, documentos, correos, teléfonos, direcciones, requisitos ni notas. La respuesta es JSON cerrado de prioridad, siguiente acción, motivos enumerados y confianza en basis points, sin texto libre ni cambios automáticos de precios u oportunidades.

La credencial `gemini` contiene API key, modelo y base oficial `https://generativelanguage.googleapis.com/v1beta/models`, cifrados en la bóveda por ambiente y administrados desde `/admin/integraciones`. `B2bCopilotService` exige `b2b:write`, registra ejecuciones idempotentes en `OpportunityCopilotRun`, escribe auditoría y conserva solo hashes de entrada/prompt y la salida enumerada; errores HTTP/transporte se clasifican sin reintentos ciegos ni respuestas crudas. `/admin/b2b/[id]` ejecuta y presenta resultados con MFA reciente.

## Mercado Libre OAuth PKCE y cuentas de canal

`MercadoLibreOAuthClient` implementa el flujo Authorization Code con PKCE `S256` para `MCO`, formularios server-side acotados y validación estricta de tokens, alcance `offline_access read write` (más scopes granulares `urn:ml:*` canónicos), vendedor y expiración, mientras `resolveMercadoLibreOAuthCookiePolicy` asegura cumplimiento RFC 6265bis (`__Secure-` con `Path` acotado al callback). `ChannelAccountService` conserva solo el hash del estado OAuth y cifra `client_secret`, verifier y access/refresh tokens en `IntegrationCredential` con AAD por ambiente (bloqueando revocaciones o rotaciones directas en bóveda sobre cuentas/intentos activos); callbacks son de un solo uso y toda repetición o suspensión de actor se rechaza fail-closed antes de llamar al proveedor.

La renovación usa un reclamo UUID persistente, no mantiene transacciones durante HTTP y guarda el nuevo `refresh_token` con control optimista de nonce. Un timeout, respuesta inválida, grant rechazado o reclamo vencido revoca el acceso, emite alerta `channels.reauth` en `/admin/hoy` y exige nueva autorización, nunca reintenta ciegamente un token de un solo uso. Reconectar valida el mismo vendedor y reemplaza la credencial en una transacción; desvincular bloquea carreras con renovaciones o autorizaciones en curso, cancela intentos pendientes y siempre bloquea localmente distinguiendo revocación remota confirmada de incierta.

`/admin/canales` aplica `integrations:*` + MFA reciente y auditoría sin secretos. `POST /api/jobs/channels` exige `CHANNEL_CRON_SECRET` y `CHANNEL_JOB_ACTOR_ID` con `integrations:write`, expira intentos y renueva únicamente cuentas próximas a vencer. `MERCADO_LIBRE_TOKEN_URL` solo admite fixtures loopback en `LOCAL`; los endpoints productivos son fijos y oficiales.

## User Products, ofertas, Full y precios

`MercadoLibreUserProductsClient` usa endpoints oficiales (loopback solo en pruebas) para validar `user_product_seller`, subir imágenes, crear y actualizar ítems, consultar stock y buscar por SKU. Toda respuesta se valida en esquema, vendedor, dinero COP entero, cantidades, logística y `x-version`; los errores separan rechazo, recurso ausente, conflicto e incertidumbre.

`ChannelCatalogService` persiste `ChannelListing`, `ChannelOffer` y `ChannelSyncJob` con snapshots inmutables, request hash, versiones y un claim por listing. Admite múltiples condiciones de venta sobre el mismo User Product, `FORMULA`/`MANUAL`, tarifas explícitas y neto `BigInt`. El scheduler detecta drift por oferta: `LOCAL_MAIN` actualiza `available_quantity` o `seller_warehouse` según la configuración multi-origen; `MELI_FULL` solo lee `meli_facility`. Un `409` obliga a releer `x-version` antes del único reintento inmediato y toda escritura se confirma con otra lectura.

Una respuesta incierta no se repite: publicación queda pendiente de conciliación por SKU y las escrituras se comparan con el estado remoto. `/admin/canales` exige MFA reciente para crear/editar/procesar, y `/api/jobs/channels` renueva tokens y procesa drift/jobs con actor autorizado. Desvincular bloquea jobs en vuelo, cancela pendientes y pausa publicaciones; `channels.sync` alerta divergencias y errores sin PII ni secretos.

## Worker de dominio

`DomainEventWorker` usa `claim_domain_outbox_events` para no consumir eventos ajenos, ejecuta efectos idempotentes y aplica backoff acotado antes de `fail_domain_outbox`. Los payloads llevan UUIDs y referencias, nunca correos, direcciones, teléfonos, documentos ni tokens; el enlace del recibo se deriva en servidor desde su UUID de envío. Para `cart.abandoned.v1` recupera el estado real del carrito, valida contacto/consentimiento, genera una clave por actividad y registra `QUEUED`, `NO_CONTACT`, `NO_CONSENT`, `SUPPRESSED` o `STALE`. Para `lifecycle.message.dispatch.v1` valida `dispatchVersion`, sella el contenido del paso y completa la inscripción únicamente cuando todos los correos fueron aceptados; un fallo terminal cancela los pasos futuros. `POST /api/jobs/domain-events` exige `DOMAIN_WORKER_CRON_SECRET` y procesa hasta cuatro lotes por invocación.
