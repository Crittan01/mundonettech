# `@mundonettech/core`

Servicios puros y compartidos, sin identidad comercial ni dependencias de aplicación. El dinero usa `BigInt` en centavos COP.

Contratos actuales:

- RBAC de ocho roles y tres anillos, permisos para catálogo, contenido y configuración (`catalog:*`, `content:*`, `settings:*`), navegación autorizada y controles de asignación entre anillos. Formato COP y conversión de pesos enteros a centavos sin floats (`formatCopCents`, `parseWholeCopToCents`).
- Máscaras de correo, teléfono, nombre e identificadores, además de redacción profunda y acotada de metadatos de auditoría.
- Política de contraseñas, normalización de correo y verificación HIBP k-anonymity con timeout, padding y respuestas estrictamente validadas.
- Verificación Cloudflare Turnstile con acción/hostname y errores cerrados.
- Tokens HMAC-SHA256 de actividad para admin/cliente/reset, validación de sujeto/tipo, idle y expiración absoluta, y renovación deslizante sin extender el límite absoluto.
- Compuerta de correo saliente (`isOutboundEmailDisabled`, `assertOutboundEmailAllowed`, `OutboundEmailDisabledError`) para bloquear despachos externos cuando `EMAIL_SEND_DISABLED=1` está activo.
- Catálogo y redirecciones: validación GS1 (`isValidGs1`, `assertValidGs1`) y EAN-8/13 (`isValidEan`, `assertValidEan`) rechazando ceros ficticios, normalización SKU, rutas de árbol N-niveles (`buildCategoryPath`, `categoryDepth`, `assertCategoryMove`), grafo de redirecciones locales anti-ciclos y tope global de 100 saltos (`normalizeRedirectPath`, `redirectChain`, `assertRedirectAllowed`), atributos tipados en paridad exacta con PostgreSQL 17 y validación monetaria `BigInt` (`assertCatalogMoney`).
- Inventario: disponibilidad efectiva (`max(0, onHand - committed - safetyStock)`), cantidades enteras de 32 bits, división/prorrateo *half-up* con `BigInt`, WAC exacto (`calculateWeightedAverageCost`), claves idempotentes, códigos normalizados, seriales e IMEI con dígito Luhn.
- CSV: parser RFC 4180 con BOM, CRLF, comillas escapadas, preservación de celdas vacías entrecomilladas, límites tempranos de bytes/filas/campos y errores por línea; contrato tipado de stock con dinero `BigInt`, seriales JSON e IMEI únicos globalmente; exportación que escapa celdas y neutraliza prefijos de fórmulas (`=`, `+`, `-`, `@`, tabulación y retorno, incluso tras espacios o BOM).
