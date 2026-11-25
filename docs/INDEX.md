# Índice Maestro de Documentación — MundoNetTech

> Toda la documentación del repositorio es **viva, libre de bitácoras fechadas y sujeta a presupuestos de tamaño en CI (`make check`)**.

## Nivel 0 — Arranque obligatorio en cada sesión (Tope CI ≤ 13 KB totales)

| Archivo | Tope | Propósito |
| --- | --- | --- |
| [`../AGENTS.md`](../AGENTS.md) | ≤ 120 lín. | Mandatos no negociables, divulgación progresiva y protocolo de sesión |
| [`STATE.md`](STATE.md) | ≤ 120 lín. | Fotografía viva de ambientes (`LOCAL`, `STG`, `PRD`) y pendientes reales |
| [`PLAN.md`](PLAN.md) | ≤ 160 lín. | Workboard maestro: resumen de fases + detalle de la fase activa + Handoff |

## Nivel 1 — Arquitectura y gobierno transversal (Lectura condicional según tarea)

| Archivo | Cuándo leerlo |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Al diseñar o modificar paquetes `packages/*`, rutas `apps/web`, esquemas Prisma, medios 360°/3D, inventario, impuestos, pagos, logística o seguridad |
| [`DECISIONS.md`](DECISIONS.md) | Al consultar o actualizar decisiones arquitectónicas (`ADR-001`…`ADR-051`) |
| [`SECURITY.md`](SECURITY.md) | Modelo de amenazas OWASP/STRIDE, sesiones, RBAC 8 roles, MFA `aal2`, RLS y bóveda `AES-256-GCM` |
| [`COMPLIANCE.md`](COMPLIANCE.md) | Ley 1480/2439, Ley 1581, documentos/SLA legales, régimen dual IVA/UVT/DIAN y SEO técnico |
| [`OPERATIONS.md`](OPERATIONS.md) | Variables de entorno, Podman local, pruebas PG17/RLS/E2E, CI/CD y despliegue standalone |

## Nivel 2 — Documentación co-localizada con el código

Cada paquete en `packages/<nombre>/README.md` documenta sus propios contratos, esquemas e invariantes junto al código que los implementa (y se mantiene actualizado en el mismo commit/PR).
