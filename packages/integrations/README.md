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
- `StoreCreditAccount` y `StoreCreditEntry` mantienen saldos disponible/retenido, versiones monotónicas y una secuencia por cuenta. `HOLD`, `CAPTURE`, `RELEASE` y `REFUND` se validan como cadena en PostgreSQL.
- Toda captura total descuenta inventario reservado una única vez y emite outbox sin PII. Reembolsos y anulaciones actualizan el estado agregado sin superar las capturas disponibles.

`INTEGRATION_ENVIRONMENT` selecciona `LOCAL`, `STG` o `PRD` (con inferencia segura de Vercel). Wompi exige llaves `test` fuera de PRD y `prod` en PRD. Los proveedores HTTP no reintentan automáticamente resultados inciertos y validan tamaño, esquema, importe y referencias de cada respuesta.

## Logística asíncrona y Flex

`ShippingService` crea fulfillments solo tras pago o con COD abierto, valida alistamiento y empaqueta cada unidad exactamente una vez con valor declarado `BigInt`. `AveonlineShippingProvider` autentica y genera una guía por bulto con `dsreferencia` determinista; el claim persistente impide dobles emisiones concurrentes y un timeout pasa a `RECONCILING`, donde `findLabel` debe confirmar existencia o ausencia antes de cualquier reintento. `FlexShippingProvider` emite referencias locales deterministas y el conductor queda sellado al despachar.

Antes del despacho, `assignSerialUnits` o `markShipped` con `serialUnitIds` exige unidades `SOLD` de la misma orden, bodega y variante, con cantidades exactas agregadas por variante. La asignación `SerializedUnit.shipmentId` se bloquea contra carreras, se audita y solo puede modificarse antes del despacho; PostgreSQL vuelve a validar la cobertura al cambiar de estado.

Las credenciales `aveonline` contienen usuario, clave, empresa, remitente y endpoints oficiales de autenticación/generación/consulta; se almacenan exclusivamente en la bóveda. `/admin/logistica` opera con `fulfillment:*` + MFA y permite multi-bulto, conciliación, despacho, entrega y zonas Flex. `LocalDeliveryZone` conserva polígonos enteros E6, DANE, tarifa y corte; checkout recotiza en servidor y sella zona/coordenadas/promesa.

## Resend, Svix y baja RFC 8058

`EmailService` versiona plantillas, congela asunto/HTML/texto/variables por evento y reutiliza la misma clave idempotente de Resend en reintentos. Los eventos Svix se verifican con HMAC y ventana anti-replay, deduplican `svix-id` y solo avanzan la jerarquía de entrega. Rebotes y quejas crean supresión por destinatario/tema; `/email/baja/[token]` acepta `POST` RFC 8058 sin cookies ni redirección y el token HMAC solo se guarda como hash.

La credencial `resend` contiene API key, remitente, endpoint, secreto Svix y secreto HMAC de baja en la bóveda. `EMAIL_SEND_DISABLED=1` bloquea todo envío externo antes del fetch. `/admin/comunicaciones` usa `communications:*` + MFA y enmascara destinatarios.

## Factura electrónica DIAN

`InvoiceService` serializa consecutivos por resolución, sella el régimen IVA del comprador, genera UBL 2.1 con CUFE/CUDE SHA-384 y montos enteros COP, y solo acepta documentos cuando el proveedor autorizado devuelve XML firmado y el identificador coincide. `DianInvoiceProvider` transmite y consulta por CUFE/CUDE; claims y estados `TRANSMITTING`/`UNCERTAIN` evitan doble transmisión. Las notas crédito se vinculan a factura aceptada y reembolso completado con cuadre diferido en PG17, incluidos casos de flete sin productos.

La credencial `dian` incluye token, endpoint del proveedor autorizado, identidad/DANE del emisor, software y resolución vigente; nunca se fabrican esos datos. `/admin/facturacion` usa `invoices:*` + MFA, auditoría transaccional y máscaras de PII. `/api/recibos/[token]/documentos/[kind]/[id]` entrega XML aceptado con el token del recibo, `no-store` y `nosniff`.

## Worker de dominio

`DomainEventWorker` usa `claim_domain_outbox_events` para no consumir eventos ajenos, ejecuta efectos idempotentes y aplica backoff acotado antes de `fail_domain_outbox`. Los payloads llevan UUIDs y referencias, nunca correos, direcciones, teléfonos, documentos ni tokens; el enlace del recibo se deriva en servidor desde su UUID de envío. `POST /api/jobs/domain-events` exige `DOMAIN_WORKER_CRON_SECRET` y procesa hasta cuatro lotes por invocación.
