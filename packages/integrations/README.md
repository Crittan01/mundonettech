# `@mundonettech/integrations`

Puertos desacoplados de integraciones y bóveda operativa de credenciales. No contiene secretos, identidad visual ni credenciales de ejemplo en código productivo.

## Bóveda AES-256-GCM

`IntegrationCredentialVault` persiste credenciales mediante `@mundonettech/db` y ofrece creación, revelado, rotación, recifrado con la clave activa, revocación y listado paginado. Los descriptores nunca incluyen nonce, ciphertext ni tag. Cada mutación escribe `AdminActionLog` en la misma transacción y la rotación usa el nonce anterior como token optimista de concurrencia.

- Claves de 32 bytes, nonce aleatorio de 12 bytes y tag de 16 bytes; plaintext limitado a 64 KiB.
- AAD vinculado al UUID y ambiente de la credencial. Los llaveros `LOCAL`, `STG` y `PRD` se cargan por variables independientes y no pueden descifrar datos de otro ambiente.
- Las versiones antiguas permanecen disponibles para descifrar; solo la versión activa cifra. Los errores no incluyen claves ni plaintext.
- El llamador debe evitar logs de secretos y sobrescribir los buffers de plaintext cuando dejen de necesitarlos.

Configura `INTEGRATION_CREDENTIAL_KEYS_<AMBIENTE>` como JSON `{ "1": "base64-de-32-bytes" }` e `INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_<AMBIENTE>`. Genera cada clave con `openssl rand -base64 32` y adminístrala en la bóveda de secretos del ambiente, nunca en Git.
