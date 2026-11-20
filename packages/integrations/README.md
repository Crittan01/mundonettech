# `@mundonettech/integrations`

Puertos desacoplados de integraciones y bóveda operativa de credenciales. No contiene secretos, identidad visual ni credenciales de ejemplo en código productivo.

## Bóveda AES-256-GCM

`IntegrationCredentialVault` persiste credenciales mediante `@mundonettech/db` y ofrece creación, revelado, rotación, recifrado con la clave activa, revocación y listado paginado. Los descriptores nunca incluyen `nonce`, `ciphertext` ni `authTag`. Toda mutación registra `AdminActionLog` (incluyendo `requestId`, `ipHash` y `userAgentHash` opcionales) en la misma transacción y usa el `nonce` previo como token optimista de concurrencia.

- Claves de 32 bytes, nonce aleatorio de 12 bytes y tag de 16 bytes; plaintext limitado a 64 KiB.
- AAD vinculado criptográficamente a ambiente, UUID, `provider` y `accountName` de la credencial. Los llaveros `LOCAL`, `STG` y `PRD` se cargan por variables independientes y no pueden descifrar ni listar datos de otro ambiente.
- Las versiones antiguas permanecen disponibles para descifrar; solo la versión activa cifra. Los errores nunca exponen claves ni plaintext.

Configura `INTEGRATION_CREDENTIAL_KEYS_<AMBIENTE>` como JSON `{ "1": "base64-de-32-bytes" }` e `INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_<AMBIENTE>`, generadas con `openssl rand -base64 32` en el gestor de secretos de cada ambiente.
