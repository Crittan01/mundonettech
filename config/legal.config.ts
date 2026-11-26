import { storeConfig } from "./store.config.js";

const effectiveDate = "2026-11-23";
const version = "1.1.0";
const law1480 = {
  label: "Ley 1480 de 2011 — Estatuto del Consumidor",
  href: "https://www.secretariasenado.gov.co/senado/basedoc/ley_1480_2011.html",
};
const law2439 = {
  label: "Ley 2439 de 2024 — protección del consumidor de comercio electrónico",
  href: "https://www.secretariasenado.gov.co/senado/basedoc/ley_2439_2024.html",
};
const law1581 = {
  label: "Ley 1581 de 2012 — protección de datos personales",
  href: "https://www.secretariasenado.gov.co/senado/basedoc/ley_1581_2012.html",
};
const sic = {
  label: "Superintendencia de Industria y Comercio",
  href: "https://www.sic.gov.co/",
};

function section(
  id: string,
  title: string,
  paragraphs: readonly string[],
  extras: {
    bullets?: readonly string[];
    links?: readonly { label: string; href: string }[];
  } = {},
) {
  return { id, title, paragraphs, ...extras };
}

export const legalConfig = {
  operator: {
    legalName: storeConfig.name,
    tradeName: storeConfig.name,
    countryCode: "CO",
    siteUrl: storeConfig.url,
    contactEmail: "servicioalcliente@mundonettech.co",
    privacyEmail: "privacidad@mundonettech.co",
  },
  documents: [
    {
      slug: "terminos-y-condiciones",
      title: "Términos y condiciones de compra",
      summary:
        "Reglas claras para consultar el catálogo, crear una cuenta y comprar tecnología en Colombia.",
      version,
      effectiveDate,
      sections: [
        section(
          "identificacion",
          "Identificación y ámbito",
          [
            `${storeConfig.name} opera el comercio electrónico disponible en ${storeConfig.url} y comercializa productos de tecnología en Colombia.`,
            "Estos términos regulan la navegación, el registro, las ofertas y las compras realizadas directamente en el sitio. Al enviar un pedido aceptas las condiciones informadas en esa transacción, sin que ello reduzca los derechos irrenunciables que te reconoce la ley colombiana.",
          ],
          { links: [law1480, law2439] },
        ),
        section("capacidad", "Capacidad y cuenta", [
          "Debes tener capacidad legal para contratar. Si una compra requiere autorización de padres, madres o representantes, esa autorización debe obtenerse antes de finalizarla.",
          "Tus credenciales son personales. Debes suministrar datos veraces, mantener actualizada tu información y avisarnos si detectas un acceso no autorizado. Podemos bloquear una cuenta ante fraude, suplantación o riesgo de seguridad, preservando las reclamaciones y obligaciones pendientes.",
        ]),
        section("ofertas", "Información y disponibilidad de ofertas", [
          "Cada ficha presenta las características, marca, autenticidad, garantía, variantes, precio y disponibilidad que constan en el catálogo al momento de la consulta. Las imágenes complementan, pero no sustituyen, la descripción y las especificaciones del producto.",
          "Las promociones indican su vigencia y condiciones. La disponibilidad se confirma durante el checkout mediante una nueva validación de inventario; un producto en el carrito no constituye una reserva definitiva.",
        ]),
        section("precios", "Precios y pagos", [
          "Los precios se expresan en pesos colombianos y los valores monetarios se calculan en centavos para evitar errores de redondeo. Antes de pagar verás el detalle de productos, descuentos, impuestos aplicables y costos de envío informados.",
          "El pedido queda sujeto a la autorización y confirmación del medio de pago. No almacenamos números completos de tarjetas en el contenido editorial ni en el catálogo. Si detectamos un cobro duplicado o una operación no confirmada, podrás solicitar su revisión por el canal de atención.",
        ]),
        section("formacion", "Formación y confirmación del pedido", [
          "Puedes revisar y corregir los datos antes de confirmar. La aceptación del pedido se produce cuando validamos pago, inventario y condiciones de la operación; cualquier imposibilidad se comunica con el detalle de la devolución o ajuste que corresponda.",
          "Conserva el comprobante de compra y el número de orden. Estos documentos permiten ejercer garantías, retracto, reversión del pago cuando proceda y solicitudes de posventa.",
        ]),
        section(
          "entrega",
          "Entrega y riesgo",
          [
            "El plazo de entrega aceptado se informa antes de finalizar la transacción. La recepción debe verificarse al entregar; registra cualquier daño visible y comunícalo oportunamente junto con el número de orden y las evidencias disponibles.",
            "Las reglas completas sobre despacho, retrasos, indisponibilidad y recogida están en la política de envíos y entregas.",
          ],
          { links: [{ label: "Envíos y entregas", href: "/legal/envios-y-entregas" }] },
        ),
        section(
          "derechos",
          "Retracto, devoluciones y garantías",
          [
            "Puedes ejercer los derechos de retracto, devolución, garantía y reversión del pago en los casos previstos por la normatividad vigente. Ninguna cláusula de este sitio limita una garantía legal ni te obliga a aceptar un saldo a favor en sustitución de un reembolso que legalmente corresponda.",
          ],
          {
            links: [
              { label: "Retracto y devoluciones", href: "/legal/retracto-y-devoluciones" },
              { label: "Garantías", href: "/legal/garantias" },
            ],
          },
        ),
        section("propiedad", "Propiedad intelectual y uso del sitio", [
          "El software, la identidad visual, los textos propios y la organización del sitio están protegidos por las normas aplicables. Las marcas de los fabricantes pertenecen a sus respectivos titulares y se utilizan para identificar productos y compatibilidades.",
          "No puedes interferir con controles de seguridad, extraer datos personales, automatizar accesos abusivos ni utilizar el sitio para fraude o infracción de derechos.",
        ]),
        section(
          "responsabilidad",
          "Responsabilidad y normas aplicables",
          [
            "Respondemos por las obligaciones legales y contractuales que nos corresponden. Ninguna exclusión se interpreta para excluir dolo, culpa grave, defectos de los productos o responsabilidades que la ley no permita limitar.",
            "Estos términos se rigen por la ley colombiana. Las autoridades y jueces competentes conservan sus atribuciones, y puedes acudir a la Superintendencia de Industria y Comercio para la protección de tus derechos.",
          ],
          { links: [sic] },
        ),
        section("contacto", "Contacto y actualizaciones", [
          `Para solicitudes sobre una compra escribe a servicioalcliente@${storeConfig.domain}. Indica tu número de orden cuando exista y evita enviar contraseñas, códigos OTP o datos completos de instrumentos de pago.`,
          "Las modificaciones aplican a operaciones posteriores a su publicación, salvo que una norma exija efectos diferentes. La versión y fecha de entrada en vigor aparecen al inicio de este documento.",
        ]),
      ],
    },
    {
      slug: "privacidad",
      title: "Aviso de privacidad",
      summary: "Qué datos tratamos, para qué los usamos y cómo puedes ejercer tus derechos.",
      version,
      effectiveDate,
      sections: [
        section(
          "responsable",
          "Responsable del tratamiento",
          [
            `${storeConfig.name} decide sobre las bases de datos asociadas con la operación de ${storeConfig.url}. El canal para consultas y reclamos de privacidad es privacidad@${storeConfig.domain}.`,
            "Este aviso resume el tratamiento aplicado en el sitio. La política de tratamiento de datos personales desarrolla los principios, procedimientos y condiciones aplicables.",
          ],
          {
            links: [
              law1581,
              {
                label: "Política de tratamiento de datos",
                href: "/legal/tratamiento-datos-personales",
              },
            ],
          },
        ),
        section(
          "datos",
          "Datos que podemos tratar",
          [
            "Tratamos los datos necesarios para autenticar tu cuenta, atender pedidos, procesar entregas y pagos, responder solicitudes, prevenir fraude y cumplir obligaciones legales.",
          ],
          {
            bullets: [
              "Identificación y contacto: nombre, correo, teléfono y datos de verificación cuando sean necesarios.",
              "Transacción y posventa: dirección de entrega, productos, estado del pedido, comprobantes y comunicaciones.",
              "Seguridad técnica: registros de autenticación, factores MFA, eventos y señales necesarias para prevenir abuso.",
              "Preferencias y autorizaciones: consentimientos, revocaciones y elecciones de comunicaciones.",
            ],
          },
        ),
        section(
          "finalidades",
          "Finalidades principales",
          [
            "La finalidad determinante es operar la relación de consumo y mantener la seguridad del servicio. Las comunicaciones promocionales, segmentaciones o usos no necesarios para ejecutar la compra requieren la autorización o el fundamento que corresponda y puedes revocarlos sin afectar servicios esenciales.",
          ],
          {
            bullets: [
              "Crear y proteger tu cuenta y las sesiones administrativas.",
              "Gestionar pedidos, pagos, entregas, devoluciones, garantías y atención al consumidor.",
              "Cumplir deberes contables, tributarios, de protección al consumidor y prevención del fraude.",
              "Enviar comunicaciones comerciales únicamente cuando exista autorización válida y ofrecer siempre una vía de baja.",
              "Medir la atribución publicitaria mediante Meta Conversions API solo con autorización publicitaria explícita, usando identificadores seudonimizados y datos de compra, sin incluir dirección, documento, IP ni agente de navegador.",
            ],
          },
        ),
        section("derechos", "Tus derechos", [
          "Puedes conocer, actualizar, rectificar y solicitar la supresión de tus datos cuando proceda; consultar autorizaciones y usos; revocar consentimientos; presentar quejas ante la autoridad y ejercer los demás derechos previstos en la Ley 1581 de 2012 y sus normas complementarias.",
          "La revocatoria o supresión no aplica cuando existe un deber legal o contractual de conservación. En esos casos limitamos el uso a la finalidad que justifica conservar el dato.",
        ]),
        section("seguridad", "Seguridad y conservación", [
          "Aplicamos controles de acceso, cifrado de secretos, registros de seguridad, enmascaramiento de información y políticas de conservación diferenciadas. Ningún sistema es infalible, pero investigamos los incidentes y adoptamos medidas de contención y notificación conforme a su gravedad y a la normativa aplicable.",
          "Conservamos la información durante el tiempo necesario para la finalidad informada y los plazos legales. Después se suprime, anonimiza o bloquea de forma segura según corresponda.",
        ]),
        section("terceros", "Encargados y transferencias", [
          "Podemos usar proveedores de infraestructura, autenticación, pagos, almacenamiento, comunicaciones y logística bajo contratos y controles de confidencialidad y seguridad. Solo reciben la información necesaria para la función contratada.",
          "Cuando autorizas publicidad, Meta recibe mediante Conversions API hashes de identificadores de contacto, identificador seudonimizado de cliente y datos de la compra para atribución. Puedes revocar esta finalidad desde tu cuenta; la revocación cancela los envíos pendientes.",
          "Una transferencia o transmisión internacional se realiza con las garantías y el fundamento jurídico exigidos por la normativa colombiana. No vendemos tus datos personales.",
        ]),
        section("solicitudes", "Cómo ejercer tus derechos", [
          `Escribe a privacidad@${storeConfig.domain} con tu nombre, correo asociado, descripción de la solicitud y los soportes pertinentes. No incluyas contraseñas ni códigos de verificación. Podemos pedir información proporcionada para validar tu identidad antes de revelar o modificar datos.`,
          "Las consultas se atienden dentro de los términos legales. Si necesitamos información adicional te explicaremos qué falta y cómo completarla.",
        ]),
      ],
    },
    {
      slug: "tratamiento-datos-personales",
      title: "Política de tratamiento de datos personales",
      summary:
        "Política integral de autorización, uso, conservación, seguridad y ejercicio de derechos.",
      version,
      effectiveDate,
      sections: [
        section(
          "marco",
          "Marco y principios",
          [
            "Esta política implementa los principios de legalidad, finalidad, libertad, veracidad, transparencia, acceso restringido, seguridad y confidencialidad. Tratamos únicamente datos adecuados, pertinentes y no excesivos frente a finalidades determinadas, explícitas y legítimas.",
          ],
          { links: [law1581] },
        ),
        section("responsable", "Responsable, encargados y titulares", [
          `${storeConfig.name} actúa como responsable frente a las bases de datos de clientes, usuarios y solicitudes. Los proveedores tecnológicos y operativos que tratan datos por cuenta nuestra actúan como encargados bajo instrucciones documentadas.`,
          "La condición de titular corresponde a la persona natural a quien se refiere el dato. Las solicitudes de terceros exigen acreditar representación y alcance.",
        ]),
        section("autorizacion", "Autorización y excepciones", [
          "Solicitamos autorización previa, expresa e informada cuando la norma la exige y conservamos evidencia de su otorgamiento, alcance y revocación. La autorización no se obtiene mediante cláusulas ambiguas ni se condiciona una compra a finalidades publicitarias innecesarias.",
          "Algunos tratamientos pueden apoyarse en excepciones legales, como ejecutar un contrato, proteger un interés vital, cumplir una obligación jurídica o atender requerimientos de autoridades. En esos casos informamos la finalidad y limitamos el tratamiento a lo necesario.",
        ]),
        section(
          "finalidades",
          "Finalidades por contexto",
          [
            "Las finalidades se separan por contexto para impedir usos incompatibles con lo informado.",
          ],
          {
            bullets: [
              "Clientes: registro, autenticación, checkout, facturación, entrega, posventa, garantías y prevención del fraude.",
              "Administradores: control de acceso, MFA, trazabilidad de acciones, seguridad y cumplimiento de funciones.",
              "Comunicaciones: envío de contenidos o promociones autorizados y gestión de bajas y revocaciones.",
              "Publicidad opcional: atribución de compras mediante Meta Conversions API con hashes de contacto, identificador seudonimizado, contenidos y valor del pedido; nunca se envían dirección, documento, IP, agente de navegador ni identificadores sin autorización vigente.",
              "Seguridad: detección de abuso, protección de cuentas, investigación de incidentes y respaldo de operaciones.",
              "Cumplimiento: conservación contable, tributaria, contractual y atención de autoridades competentes.",
            ],
          },
        ),
        section("sensibles", "Datos sensibles y menores", [
          "No solicitamos datos sensibles para vender productos ordinarios. Si una operación excepcional los requiriera, informaremos el carácter facultativo de la respuesta y aplicaremos protecciones reforzadas.",
          "El tratamiento de datos de niños, niñas y adolescentes debe respetar su interés superior y derechos fundamentales; se exige autorización válida y se limita la información a lo estrictamente necesario.",
        ]),
        section(
          "derechos",
          "Derechos del titular",
          [
            "La Ley 1581 reconoce derechos que puedes ejercer sin costo dentro de los cauces legales.",
          ],
          {
            bullets: [
              "Conocer, actualizar y rectificar datos frente a responsables y encargados.",
              "Solicitar prueba de la autorización y recibir información sobre el uso dado a los datos.",
              "Revocar la autorización y pedir supresión cuando no exista deber de conservación.",
              "Presentar quejas ante la Superintendencia de Industria y Comercio y ejercer acciones constitucionales.",
              "Acceder de forma gratuita a los datos cuyo tratamiento se realice por el responsable, en los términos legales.",
            ],
          },
        ),
        section("procedimiento", "Procedimiento de consultas y reclamos", [
          `Radica tu solicitud en privacidad@${storeConfig.domain}. Describe de forma clara si consultas, corriges, revocas o solicitas supresión e incluye soportes útiles. Verificaremos la identidad de manera proporcional antes de responder.`,
          "Las consultas se responden en un máximo de diez días hábiles. Los reclamos se tramitan en hasta quince días hábiles; cuando no sea posible responder dentro del término, informamos los motivos y la nueva fecha dentro de los límites legales. Si la solicitud está incompleta, se solicitará la corrección conforme al procedimiento aplicable.",
          "El responsable mantiene trazabilidad de recepción, respuesta, correcciones y bloqueos necesarios mientras se resuelve una controversia.",
        ]),
        section("retencion", "Conservación, supresión y anonimización", [
          "Definimos plazos según la finalidad y las obligaciones aplicables. Las cuentas inactivas, autorizaciones, pedidos, registros de seguridad y comprobantes pueden tener plazos diferentes.",
          "Al finalizar la conservación, el dato se elimina o anonimiza de manera que no pueda asociarse nuevamente a una persona. Si debe bloquearse por una controversia o requerimiento, se restringe su acceso y uso hasta que la causa termine.",
        ]),
        section("seguridad", "Medidas de seguridad", [
          "Usamos control de acceso por roles, autenticación multifactor administrativa, sesiones firmadas con expiración, aislamiento estricto de datos por defecto, bóveda cifrada de credenciales, minimización de datos, enmascaramiento de datos personales y registros de auditoría. Los respaldos se cifran y su recuperación se verifica operativamente.",
          "Los accesos se limitan por necesidad de conocer. Ante una vulneración evaluamos alcance, riesgo y obligaciones de reporte, contenemos el incidente y documentamos las acciones correctivas.",
        ]),
        section("vigencia", "Vigencia y cambios", [
          "Esta política rige desde la fecha indicada. Cambios sustanciales se publican y, cuando corresponda, se solicita una nueva autorización. Una modificación no retrotrae derechos ya ejercidos ni justifica finalidades incompatibles con la autorización original.",
        ]),
      ],
    },
    {
      slug: "cookies",
      title: "Política de cookies y tecnologías similares",
      summary:
        "Uso limitado y transparente de cookies necesarias para autenticación, seguridad y funcionamiento.",
      version,
      effectiveDate,
      sections: [
        section("definicion", "Qué son", [
          "Las cookies son pequeños identificadores que un sitio puede almacenar o leer en el navegador. Tecnologías similares permiten conservar una sesión, proteger formularios o recordar una elección. No todo almacenamiento contiene datos personales, pero aplicamos esta política cuando pueda relacionarse contigo o con tu dispositivo.",
        ]),
        section(
          "uso",
          "Cookies que utiliza el sitio",
          [
            "El funcionamiento actual requiere cookies estrictamente necesarias para autenticación, continuidad y expiración de sesiones, protección de formularios y prevención de abuso. No utilizamos cookies publicitarias propias ni vendemos perfiles de navegación.",
          ],
          {
            bullets: [
              "Sesión de Supabase: mantiene y renueva el acceso autenticado mediante cookies httpOnly.",
              "Actividad administrativa y de cliente: verifica inactividad, duración máxima y tipo de sesión con tokens firmados.",
              "Continuidad funcional solicitada: conserva el carrito activo, el acceso temporal verificado de posventa invitada y el código al abrir un enlace de referido mediante cookies httpOnly, sin rastreo publicitario.",
              "Seguridad: permite retos anti-automatización y controles necesarios para impedir accesos fraudulentos.",
            ],
          },
        ),
        section("terceros", "Proveedores involucrados", [
          "Supabase Auth gestiona autenticación; Cloudflare Turnstile puede validar que un formulario no sea automatizado; Cloudflare R2 entrega activos multimedia. Sus operaciones se limitan a la funcionalidad prestada y pueden estar sujetas a sus propias condiciones y registros técnicos.",
          "Meta Conversions API opera únicamente entre servidores cuando otorgas autorización publicitaria. No instala el píxel de Meta ni crea cookies publicitarias en tu navegador; recibe solo los hashes y datos de compra descritos en el aviso de privacidad.",
        ]),
        section("no-esenciales", "Cookies analíticas o publicitarias", [
          "Actualmente no instalamos cookies analíticas o publicitarias no esenciales. Si se incorporan en el futuro, informaremos sus finalidades, duración y terceros antes de activarlas y solicitaremos consentimiento cuando sea exigible. Ni rechazar una cookie no esencial ni negar la autorización para Meta Conversions API impide realizar una compra.",
        ]),
        section("control", "Cómo controlarlas", [
          "Puedes borrar o bloquear cookies desde el navegador. Bloquear las estrictamente necesarias puede impedir el inicio de sesión o la finalización segura de una compra. Las preferencias de marketing pueden revocarse por los enlaces de baja y los canales de privacidad.",
        ]),
        section("contacto", "Consultas", [
          `Para preguntas sobre estas tecnologías escribe a privacidad@${storeConfig.domain}. La versión publicada identifica la fecha desde la cual aplica.`,
        ]),
      ],
    },
    {
      slug: "retracto-y-devoluciones",
      title: "Retracto, devoluciones y reversión del pago",
      summary:
        "Cómo ejercer el retracto dentro de cinco días hábiles y cómo tramitamos devoluciones y reembolsos.",
      version,
      effectiveDate,
      sections: [
        section(
          "alcance",
          "Qué es el retracto",
          [
            "En las modalidades de contratación previstas por el artículo 47 del Estatuto del Consumidor puedes resolver el contrato sin justificar tu decisión, siempre que el producto y la operación sean elegibles. El retracto es distinto de la garantía y de la reversión del pago.",
          ],
          { links: [law1480, law2439] },
        ),
        section("plazo", "Plazo para ejercerlo", [
          "Para bienes, el término máximo es de cinco días hábiles contados desde la entrega. El cálculo excluye sábados, domingos y los dieciocho festivos oficiales colombianos; si la entrega ocurre en un día no hábil, el cómputo comienza con el siguiente día hábil.",
          "Conserva la evidencia de entrega y envía la comunicación a más tardar el día de vencimiento. Los plazos se calculan con la hora oficial de Colombia (Bogotá, UTC-5) para evitar diferencias de fecha del servidor.",
        ]),
        section("excepciones", "Excepciones legales", [
          "La ley excluye determinados bienes y contratos, entre otros los personalizados, los que por naturaleza no puedan devolverse o se deterioren rápidamente, perecederos y bienes de uso personal. Una etiqueta de excepción no permite desconocer garantías ni derechos por defectos, falta de conformidad o información engañosa.",
          "Cuando un producto esté marcado para revisión de excepción, analizaremos el caso y explicaremos la decisión sin convertir esa revisión en una negativa automática.",
        ]),
        section("solicitud", "Cómo solicitarlo", [
          `Escribe a servicioalcliente@${storeConfig.domain} dentro del plazo. Incluye número de orden, producto y cantidad que deseas devolver, motivo opcional, datos de contacto y evidencias del estado del bien. No envíes claves ni números completos de tarjetas.`,
          "El retracto puede ser parcial por línea o cantidad cuando la orden contiene varios productos. Indicaremos los datos correctos y completos requeridos para la devolución y las opciones de reembolso de forma clara y específica.",
        ]),
        section("devolucion", "Condiciones y transporte", [
          "Debes devolver el producto por los medios indicados, en las mismas condiciones en que lo recibiste y con sus accesorios, manuales, empaques y elementos asociados, salvo que la ley o las circunstancias justifiquen otra actuación.",
          "Los costos de transporte y demás costos de la devolución por retracto son cubiertos por el consumidor conforme al artículo 47. Esta regla no se traslada a garantías, errores de despacho, productos defectuosos o casos donde la ley asigne el costo al proveedor.",
        ]),
        section("reembolso", "Reembolso máximo de quince días calendario", [
          "La devolución del dinero no excederá quince días calendario desde que ejerciste el retracto y cumpliste las obligaciones de suministrar los datos correctos y completos y devolver el producto en los términos aplicables. Todos los actores, incluida la entidad financiera, deben respetar ese término.",
          "El reembolso se aplica al instrumento o medio de pago correspondiente o al medio acordado. Puedes indicar tu preferencia entre las opciones informadas; no imponemos cupones ni saldos para sustituir un reembolso debido.",
        ]),
        section("reversion", "Reversión del pago", [
          "La reversión procede en operaciones electrónicas por fraude, operación no solicitada, producto no recibido, producto distinto o defectuoso, en los términos del artículo 51. Debes reclamar al proveedor, devolver el producto cuando corresponda y notificar al emisor del instrumento dentro de los cinco días hábiles siguientes al hecho que habilita la reclamación.",
          "La reversión no se confunde con el retracto: tiene causales y notificaciones específicas. Podemos orientarte, pero no eliminar los deberes de comunicación al emisor ni los controles contra solicitudes fraudulentas.",
        ]),
        section(
          "posventa",
          "Otros casos de posventa",
          [
            "Si el producto llegó dañado, incompleto, diferente o presenta fallas, utiliza también la política de garantías y el canal de PQR. Conservar el empaque y registrar evidencias ayuda, pero no puede exigirse una prueba imposible que desconozca un derecho legal.",
          ],
          {
            links: [
              { label: "Garantías", href: "/legal/garantias" },
              { label: "Peticiones, quejas y reclamos", href: "/legal/pqrs" },
            ],
          },
        ),
      ],
    },
    {
      slug: "garantias",
      title: "Garantías y soporte posventa",
      summary:
        "Cobertura legal y del fabricante, trazabilidad por serial y procedimiento de reclamación.",
      version,
      effectiveDate,
      sections: [
        section("vigencia", "Garantía legal y comercial", [
          "Todo producto incluye la garantía legal aplicable. La ficha informa los meses de garantía comercial o del fabricante cuando existen; el plazo comercial se entiende sin perjuicio de derechos legales que no puedan reducirse.",
          "La garantía cubre defectos de fabricación, idoneidad, calidad y falta de conformidad en los términos de la ley y de las condiciones informadas. No se limita a la decisión unilateral del fabricante.",
        ]),
        section(
          "cobertura",
          "Qué revisamos",
          [
            "Verificamos el defecto reportado, la fecha de compra, la identidad del producto y su historial. Para equipos con serial o IMEI contrastamos la unidad entregada con la orden y el registro de inventario.",
          ],
          {
            bullets: [
              "Fallas de funcionamiento en condiciones normales de uso.",
              "Diferencias frente a especificaciones o contenido anunciado.",
              "Accesorios o componentes faltantes asociados al producto.",
              "Problemas de autenticidad o compatibilidad expresamente garantizada.",
            ],
          },
        ),
        section("exclusiones", "Exclusiones y valoración técnica", [
          "Daños por golpes, líquidos, modificaciones no autorizadas, uso contrario al manual o desgaste ordinario pueden quedar fuera de la garantía comercial cuando sean la causa del defecto. Una exclusión requiere valoración razonada y no se presume únicamente por presentar marcas de uso.",
          "La revisión técnica no suspende derechos legales ni impide que aportes pruebas o solicites una segunda evaluación cuando exista controversia.",
        ]),
        section("procedimiento", "Cómo reclamar", [
          `Escribe a servicioalcliente@${storeConfig.domain} con número de orden, producto, serial o IMEI cuando aplique, descripción de la falla y evidencias. Indica si el equipo contiene información sensible y realiza respaldos cuando sea posible; no envíes contraseñas.`,
          "Te informaremos el procedimiento de entrega o recolección y el diagnóstico. La reparación, cambio o devolución se gestiona según la ley, la gravedad, la repetición de fallas y las opciones que te correspondan.",
        ]),
        section("datos", "Datos en equipos y accesorios", [
          "Antes de entregar un equipo para servicio, retira cuentas, SIM, memorias y accesorios que no deban revisarse, salvo que sean necesarios para reproducir la falla. Solicita instrucciones si desactivar una cuenta puede impedir el diagnóstico.",
          "El acceso a datos personales durante el soporte se limita a lo indispensable y queda sujeto a la política de tratamiento.",
        ]),
        section(
          "seguimiento",
          "Seguimiento y autoridad",
          [
            "Conserva el número de orden, comprobantes, comunicaciones y diagnósticos. Si la respuesta no es satisfactoria puedes presentar una reclamación y acudir a los mecanismos de protección al consumidor.",
          ],
          { links: [law1480, sic] },
        ),
      ],
    },
    {
      slug: "envios-y-entregas",
      title: "Política de envíos y entregas",
      summary:
        "Plazos informados, trazabilidad, indisponibilidad, recogida y derechos ante retrasos.",
      version,
      effectiveDate,
      sections: [
        section(
          "plazo",
          "Plazo aceptado antes del pago",
          [
            "Antes de finalizar la transacción informamos el plazo de entrega aplicable al destino, inventario y modalidad elegida. Ese plazo aceptado es el compromiso principal. Si no se establece uno, la entrega vence a más tardar treinta días calendario desde el día siguiente a la comunicación del pedido.",
          ],
          { links: [law2439] },
        ),
        section("preparacion", "Preparación y disponibilidad", [
          "La preparación comienza después de la confirmación requerida de pago e inventario. El stock vendible descuenta unidades comprometidas y stock de seguridad; la página de catálogo no garantiza que una unidad siga libre hasta completar el checkout.",
          "Si detectamos indisponibilidad, lo informamos sin demora. Una segunda fecha solo procede con tu aceptación; también puedes ejercer los derechos de terminación y devolución previstos por la ley.",
        ]),
        section("despacho", "Despacho y trazabilidad", [
          "Una orden puede dividirse en varios envíos o bultos cuando la logística y las ubicaciones de inventario lo exijan. Cada despacho conserva sus eventos y datos de seguimiento; no creamos guías ficticias ni marcamos productos como entregados sin evidencia operativa.",
          "Los tiempos del transportador se gestionan dentro del compromiso aceptado. Ante novedades de dirección o acceso, utiliza el canal de atención con el número de orden.",
        ]),
        section("recepcion", "Recepción y verificación", [
          "Quien recibe debe revisar el estado exterior y, cuando sea posible, el contenido. Registra inmediatamente daños, faltantes o diferencias y conserva fotografías, guías y empaques para facilitar la investigación.",
          "La ausencia de una anotación en la guía no elimina derechos por defectos, faltantes o falta de conformidad que se descubran después.",
        ]),
        section("retraso", "Retraso o indisponibilidad", [
          "Si la entrega supera el plazo pactado o el plazo legal aplicable, o el producto no está disponible, puedes terminar el contrato cuando proceda y obtener la devolución de las sumas pagadas sin retenciones indebidas.",
          "Para este supuesto, la devolución debe efectuarse en un máximo de quince días calendario. Te informaremos las opciones de pago para procesarla y conservaremos trazabilidad de la gestión.",
        ]),
        section("recogida", "Recogida en tienda y entregas locales", [
          "Cuando la recogida esté habilitada, informaremos sede, horario, identificación y plazo para reclamar. Solo la persona autorizada en la orden o quien acredite la autorización podrá retirarla.",
          "Las entregas locales pueden tener zonas, cortes y condiciones específicas que se mostrarán antes del pago. Estas condiciones no reducen los derechos por retraso o indisponibilidad.",
        ]),
      ],
    },
    {
      slug: "pqrs",
      title: "Peticiones, quejas, reclamos y sugerencias",
      summary:
        "Canales, información necesaria, términos de respuesta y seguimiento de solicitudes.",
      version,
      effectiveDate,
      sections: [
        section("tipos", "Tipos de solicitud", [
          "Una petición busca información o una actuación; una queja expresa inconformidad con la conducta o el servicio; un reclamo solicita revisar una situación concreta relacionada con un producto, cobro o entrega; una sugerencia propone mejoras. Clasificarlas correctamente permite asignar el trámite adecuado sin restar derechos.",
        ]),
        section(
          "canales",
          "Canales de atención",
          [
            `El canal general es servicioalcliente@${storeConfig.domain}; para privacidad utiliza privacidad@${storeConfig.domain}. Estos canales permiten dejar constancia escrita de la solicitud y adjuntar soportes.`,
            "No debes enviar contraseñas, códigos OTP, números completos de tarjetas ni información que no sea necesaria para tramitar el caso.",
          ],
          { links: [sic] },
        ),
        section(
          "contenido",
          "Información para radicar",
          [
            "Describe los hechos, fecha, resultado esperado y datos de contacto. Si se relaciona con una compra incluye el número de orden, producto y cantidad; para garantías agrega serial o IMEI y evidencia de la falla; para privacidad identifica el derecho que deseas ejercer.",
          ],
          {
            bullets: [
              "Nombre y correo de contacto.",
              "Número de orden o referencia de la operación, si existe.",
              "Relato claro de hechos y solicitud concreta.",
              "Soportes pertinentes sin secretos de autenticación ni datos financieros completos.",
            ],
          },
        ),
        section("trazabilidad", "Constancia y seguimiento", [
          "Conserva el correo enviado, los anexos y las respuestas como constancia de la radicación. Solicita en ese mismo hilo el identificador de seguimiento y la fecha y hora de registro cuando necesites hacer seguimiento o aportar nuevas pruebas.",
          "Las respuestas deben relacionar la solicitud y sus fundamentos. Si faltan datos, te indicaremos cuáles son necesarios sin convertir requisitos accesorios en una barrera para ejercer derechos.",
        ]),
        section("terminos", "Términos de respuesta", [
          "Las reclamaciones de consumo se responden dentro de los quince días hábiles previstos por el Estatuto del Consumidor. Las consultas y reclamos de datos personales siguen los términos especiales de diez y quince días hábiles, respectivamente, y sus reglas de prórroga o información complementaria.",
          "Cuando otra norma especial establezca un término distinto, se aplica el correspondiente y se informa en la respuesta. La falta de respuesta no convalida la actuación ni te impide acudir a la autoridad competente.",
        ]),
        section(
          "autoridad",
          "Protección del consumidor",
          [
            "Puedes acudir a la Superintendencia de Industria y Comercio, a los jueces competentes y a los mecanismos constitucionales de protección de datos. El acceso a un canal interno no sustituye esos recursos ni exige agotarlos cuando la ley no lo requiere.",
          ],
          { links: [sic, law1480, law1581] },
        ),
      ],
    },
  ],
} as const;

export type LegalConfig = typeof legalConfig;
