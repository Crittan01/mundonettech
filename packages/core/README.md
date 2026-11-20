# `@mundonettech/core`

Servicios puros y compartidos, sin identidad comercial ni dependencias de aplicación. El dinero usa `BigInt` en centavos COP cuando se implementen operaciones monetarias.

Contratos actuales:

- RBAC de ocho roles y tres anillos, permisos, navegación autorizada y controles de asignación entre anillos.
- Máscaras de correo, teléfono, nombre e identificadores, además de redacción profunda y acotada de metadatos de auditoría.
- Política de contraseñas, normalización de correo y verificación HIBP k-anonymity con timeout, padding y respuestas estrictamente validadas.
- Verificación Cloudflare Turnstile con acción/hostname y errores cerrados.
- Tokens HMAC-SHA256 de actividad para admin/cliente/reset, validación de sujeto/tipo, idle y expiración absoluta, y renovación deslizante sin extender el límite absoluto.
