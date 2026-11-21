# `@mundonettech/legal-co`

Paquete puro de cumplimiento colombiano. No importa marca, configuración, Next ni Prisma: la identidad y los ocho textos viven en `config/legal.config.ts`; las fechas usan `America/Bogota` y cálculos de fecha sola en UTC.

## Contratos

- `buildLegalConfiguration` exige exactamente ocho documentos: términos, privacidad, tratamiento de datos, cookies, retracto/devoluciones, garantías, envíos y PQR. Valida objetos cerrados, slugs, anclas únicas, texto sin HTML/controles, versión semántica, fechas reales, correos y enlaces locales/HTTPS sin credenciales.
- `colombianHolidays(year)` calcula los 18 feriados legales entre 1900 y 9999: fijos, Ley Emiliani y semana Santa/feriados dependientes de Pascua mediante Computus gregoriano. Conserva conmemoraciones que coincidan en un mismo día.
- `isColombianBusinessDay` excluye sábados, domingos y festivos. `addColombianBusinessDays` admite conteos enteros acotados y cruza años sin depender del huso del proceso.
- `calculateRetractWindow` aplica cinco días hábiles desde entrega; `evaluateRetractWindow` informa `BEFORE_DELIVERY`, `OPEN` o `CLOSED`. El vencimiento incluye todo el día local.
- `calculateRetractRefundDeadline` aplica quince días calendario al retracto. `bogotaDateOnly` conserva fechas `YYYY-MM-DD` y exige offset explícito en timestamps de texto.
- `docs/COMPLIANCE.md` distingue capacidades activas, deberes empresariales y trabajo de fases posteriores. Las leyes y decisiones de referencia están enlazadas desde fuentes oficiales.
