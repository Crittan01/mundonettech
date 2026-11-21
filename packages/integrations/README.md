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
