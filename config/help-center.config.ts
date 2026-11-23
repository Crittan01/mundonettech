export interface HelpLink {
  readonly label: string;
  readonly href: string;
}

export interface HelpSection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
  readonly bullets?: readonly string[];
  readonly links?: readonly HelpLink[];
}

export const helpCategories = [
  {
    id: "compras",
    label: "Compras y pagos",
    description: "Carrito, checkout y medios disponibles.",
  },
  { id: "pedidos", label: "Pedidos y envíos", description: "Seguimiento, bultos y recibos." },
  { id: "posventa", label: "Posventa", description: "Retracto, cambios, garantías y seriales." },
  {
    id: "cuenta",
    label: "Cuenta y beneficios",
    description: "Datos, privacidad, puntos y referidos.",
  },
  {
    id: "soporte",
    label: "Atención y PQR",
    description: "Canales de contacto y solicitudes formales.",
  },
] as const;

export type HelpCategoryId = (typeof helpCategories)[number]["id"];

export interface HelpArticle {
  readonly slug: string;
  readonly category: HelpCategoryId;
  readonly title: string;
  readonly summary: string;
  readonly keywords: readonly string[];
  readonly sections: readonly HelpSection[];
}

export const helpArticles: readonly HelpArticle[] = [
  {
    slug: "comprar-y-pagar",
    category: "compras",
    title: "Cómo comprar y pagar",
    summary: "Desde la elección de una variante hasta la confirmación segura del pedido.",
    keywords: ["carrito", "checkout", "pago", "wompi", "transferencia", "contraentrega", "crédito"],
    sections: [
      {
        heading: "Prepara tu carrito",
        paragraphs: [
          "En la ficha de cada producto elige la variante y la cantidad. El carrito vuelve a validar precio, disponibilidad, promociones y composición de bundles antes de continuar.",
        ],
        bullets: [
          "Revisa SKU, cantidades y totales antes de iniciar el checkout.",
          "Los cupones y precios mayoristas se aplican según sus condiciones vigentes en el servidor.",
          "Si una línea deja de estar disponible, el carrito lo informa sin ocultar el problema.",
        ],
        links: [
          { label: "Ir al catálogo", href: "/productos" },
          { label: "Revisar carrito", href: "/carrito" },
        ],
      },
      {
        heading: "Completa el checkout",
        paragraphs: [
          "Escribe los datos de contacto y entrega, selecciona el método disponible para tu cobertura y acepta los documentos aplicables. El servidor calcula nuevamente impuestos, flete y disponibilidad antes de confirmar.",
          "Los medios de pago que aparecen son los habilitados para ese pedido. No todos los medios aplican a todos los importes, direcciones o modalidades de entrega.",
        ],
        links: [{ label: "Condiciones de venta", href: "/legal/terminos-y-condiciones" }],
      },
      {
        heading: "Verifica el resultado",
        paragraphs: [
          "Al terminar verás el recibo con el estado comercial, financiero y logístico real. Una orden sin pago confirmado nunca se presenta como pagada. Conserva el enlace del recibo y no lo compartas públicamente.",
        ],
        links: [{ label: "Consultar tus pedidos", href: "/mi-cuenta/pedidos" }],
      },
    ],
  },
  {
    slug: "seguimiento-de-pedidos",
    category: "pedidos",
    title: "Seguimiento de pedidos y recibos",
    summary: "Consulta estados y documentos desde tu cuenta o con acceso verificado de invitado.",
    keywords: ["pedido", "recibo", "otp", "invitado", "tracking", "guía", "estado"],
    sections: [
      {
        heading: "Desde tu cuenta",
        paragraphs: [
          "Ingresa a tus pedidos para ver importes, pagos, envíos y recibos asociados a tu cuenta. Cada envío conserva su propio estado; un pedido con varios bultos puede tener entregas parciales.",
        ],
        links: [{ label: "Ver mis pedidos", href: "/mi-cuenta/pedidos" }],
      },
      {
        heading: "Compra como invitado",
        paragraphs: [
          "Abre el enlace privado del recibo que recibiste al comprar. Para consultar el pedido deberás completar el código de verificación enviado al contacto registrado; el enlace por sí solo no reemplaza ese segundo factor.",
          "Por seguridad, el código expira, tiene intentos limitados y la sesión de invitado es temporal. No reutilices enlaces ni códigos de otra persona.",
        ],
      },
      {
        heading: "Guías y estados",
        paragraphs: [
          "Cuando exista una guía, su información aparece dentro del envío correspondiente. Los estados de pago y despacho son independientes: confirmar un pago no significa que el paquete ya haya sido entregado.",
        ],
        links: [{ label: "Resolver dudas de envíos", href: "/ayuda/envios-y-entregas" }],
      },
    ],
  },
  {
    slug: "envios-y-entregas",
    category: "pedidos",
    title: "Envíos, cobertura y entregas",
    summary: "Cómo se calculan cobertura, promesas y entregas en uno o varios bultos.",
    keywords: ["envío", "entrega", "cobertura", "bultos", "flex", "click and collect", "dirección"],
    sections: [
      {
        heading: "Cobertura y promesa",
        paragraphs: [
          "La cobertura y la fecha prometida se calculan con la dirección, el método elegido, el inventario y las condiciones vigentes al confirmar. El checkout informa si una zona no tiene servicio antes de crear el pedido.",
        ],
        bullets: [
          "Verifica municipio, dirección y datos de contacto.",
          "La promesa queda asociada al envío y puede consultarse en el pedido.",
          "Una modificación de dirección posterior requiere validación operativa; no se presume aplicada por escribir otra dirección en la cuenta.",
        ],
      },
      {
        heading: "Entregas parciales y recogida",
        paragraphs: [
          "Cuando el pedido se divide, cada bulto conserva contenido y seguimiento propios. La entrega de uno no marca automáticamente los demás como entregados. Si elegiste recogida, el pedido identifica la sede seleccionada durante checkout.",
        ],
        links: [
          { label: "Consultar mis pedidos", href: "/mi-cuenta/pedidos" },
          { label: "Condiciones de envío", href: "/legal/envios-y-entregas" },
        ],
      },
    ],
  },
  {
    slug: "retracto-cambios-y-devoluciones",
    category: "posventa",
    title: "Retracto, cambios y devoluciones",
    summary: "Solicita posventa por las unidades y envíos que correspondan a tu compra.",
    keywords: ["retracto", "cambio", "devolución", "reembolso", "días hábiles", "envío"],
    sections: [
      {
        heading: "Antes de solicitar",
        paragraphs: [
          "Consulta el documento legal vigente para conocer alcance, plazos, excepciones y obligaciones. La solicitud se calcula por línea, cantidad y entrega; el total del pedido por sí solo no determina cuánto puede devolverse.",
        ],
        links: [{ label: "Retracto y devoluciones", href: "/legal/retracto-y-devoluciones" }],
      },
      {
        heading: "Radica la solicitud",
        paragraphs: [
          "Desde el detalle del pedido selecciona las cantidades entregadas y el motivo. Si el producto tiene serial o IMEI, la unidad debe corresponder al envío registrado. El sistema descuenta cantidades ya solicitadas para impedir duplicados.",
        ],
        links: [{ label: "Ir a mis pedidos", href: "/mi-cuenta/pedidos" }],
      },
      {
        heading: "Revisión y reembolso",
        paragraphs: [
          "La aprobación y el reembolso conservan estados separados. El cierre de una devolución con reembolso exige que este se haya completado; una solicitud aprobada todavía no significa dinero devuelto.",
        ],
      },
    ],
  },
  {
    slug: "garantias-y-seriales",
    category: "posventa",
    title: "Garantías, serial e IMEI",
    summary: "Valida cobertura y registra la unidad exacta para una revisión trazable.",
    keywords: ["garantía", "serial", "imei", "soporte técnico", "comprobante"],
    sections: [
      {
        heading: "Identifica la unidad",
        paragraphs: [
          "Conserva el serial o IMEI físico y el recibo de compra. La solicitud se cruza con la unidad despachada para evitar reclamos sobre productos de otra orden o variante.",
        ],
        links: [
          { label: "Consultar pedidos", href: "/mi-cuenta/pedidos" },
          { label: "Documento de garantías", href: "/legal/garantias" },
        ],
      },
      {
        heading: "Evaluación y solución",
        paragraphs: [
          "La revisión puede requerir diagnóstico y recepción de la unidad. No envíes accesorios, contraseñas ni información personal innecesaria. El resultado y cualquier reembolso aplicable quedan asociados al reclamo y al pedido.",
        ],
      },
    ],
  },
  {
    slug: "cuenta-y-privacidad",
    category: "cuenta",
    title: "Cuenta, datos personales y consentimientos",
    summary:
      "Administra tu perfil, direcciones y derechos de privacidad con evidencia persistente.",
    keywords: ["cuenta", "privacidad", "hábeas data", "consentimiento", "anonimización", "datos"],
    sections: [
      {
        heading: "Actualiza tus datos",
        paragraphs: [
          "En tu cuenta puedes mantener el perfil y las direcciones usadas en compras posteriores. Cambiar una dirección predeterminada no reescribe los snapshots legales y logísticos de pedidos ya confirmados.",
        ],
        links: [
          { label: "Mi cuenta", href: "/mi-cuenta" },
          { label: "Mis direcciones", href: "/mi-cuenta/direcciones" },
        ],
      },
      {
        heading: "Consentimientos y supresión",
        paragraphs: [
          "Puedes consultar y revocar consentimientos opcionales. La revocación detiene usos futuros asociados y conserva la evidencia exigida, sin borrar historia que deba mantenerse por obligaciones legales o financieras.",
          "La anonimización es irreversible y solo procede cuando no existen obligaciones abiertas. Elimina identificadores directos sin alterar importes, recibos ni la historia obligatoria.",
        ],
        links: [
          { label: "Privacidad y Hábeas Data", href: "/mi-cuenta/privacidad" },
          { label: "Política de privacidad", href: "/legal/privacidad" },
        ],
      },
    ],
  },
  {
    slug: "puntos-y-referidos",
    category: "cuenta",
    title: "Puntos, beneficios y referidos",
    summary: "Consulta movimientos reales y comparte tu código sin autorreferidos.",
    keywords: ["puntos", "lealtad", "beneficios", "referidos", "reembolso", "reversa"],
    sections: [
      {
        heading: "Consulta tu balance",
        paragraphs: [
          "La sección de beneficios muestra el saldo y el libro de movimientos. Los puntos se relacionan con compras elegibles y pueden revertirse proporcionalmente cuando se completan reembolsos o anulaciones.",
        ],
        links: [{ label: "Ver mis beneficios", href: "/mi-cuenta/beneficios" }],
      },
      {
        heading: "Comparte tu código",
        paragraphs: [
          "Tu código identifica la invitación durante el registro y la primera compra elegible. No es válido autorreferirse ni crear atribuciones duplicadas. La calificación depende de una compra pagada que cumpla las reglas vigentes, no solo de abrir el enlace.",
        ],
      },
    ],
  },
  {
    slug: "compras-para-empresas",
    category: "compras",
    title: "Compras para empresas",
    summary: "Solicita una propuesta B2B con precios, impuestos y vigencia sellados.",
    keywords: ["empresas", "b2b", "mayorista", "propuesta", "nit", "lista de precios"],
    sections: [
      {
        heading: "Solicita una propuesta",
        paragraphs: [
          "Registra los datos de la organización, el contacto y los requisitos comerciales en el canal empresarial. La solicitud genera una oportunidad para evaluación; no confirma inventario ni precios antes de una propuesta emitida.",
        ],
        links: [
          { label: "Canal para empresas", href: "/empresas" },
          { label: "Tratamiento de datos", href: "/legal/privacidad" },
        ],
      },
      {
        heading: "Revisa y acepta",
        paragraphs: [
          "El enlace de propuesta muestra una versión con vigencia, cantidades, valores, impuestos y flete. Al aceptar, esos datos se revalidan y se conservan en el pedido. Una versión reemplazada, cancelada o vencida no puede aceptarse como vigente.",
        ],
      },
    ],
  },
  {
    slug: "pqr-y-canales-de-atencion",
    category: "soporte",
    title: "PQR y canales de atención",
    summary: "Radica peticiones, quejas, reclamos y recursos con constancia y seguimiento.",
    keywords: ["pqr", "petición", "queja", "reclamo", "recurso", "contacto", "sla"],
    sections: [
      {
        heading: "Radica desde tu cuenta",
        paragraphs: [
          "Selecciona el tipo, el asunto y, cuando aplique, el pedido relacionado. Describe los hechos sin incluir contraseñas, códigos de verificación ni datos financieros completos. Recibirás un número para seguimiento y podrás consultar las respuestas.",
        ],
        links: [{ label: "Radicar y consultar PQR", href: "/mi-cuenta/soporte" }],
      },
      {
        heading: "Términos y canales formales",
        paragraphs: [
          "Las consultas y los reclamos tienen términos de respuesta diferenciados según la normativa colombiana. La constancia muestra la fecha límite calculada en días hábiles. Los canales institucionales y el operador están publicados en el centro legal.",
        ],
        links: [
          { label: "Procedimiento PQR", href: "/legal/pqrs" },
          { label: "Operador y canales legales", href: "/legal" },
        ],
      },
    ],
  },
] as const satisfies readonly HelpArticle[];

export const helpFaqs = [
  {
    question: "¿Dónde consulto el estado de mi pedido?",
    answer:
      "En «Mi cuenta» abre «Pedidos». Si compraste como invitado, usa el enlace privado del recibo y completa el código de verificación enviado al contacto registrado.",
  },
  {
    question: "¿Un pago confirmado significa que el pedido ya fue entregado?",
    answer:
      "No. Pago, alistamiento, despacho y entrega tienen estados independientes. Revisa cada envío y sus bultos dentro del pedido.",
  },
  {
    question: "¿Cómo inicio una devolución o garantía?",
    answer:
      "Abre el detalle del pedido entregado y selecciona las cantidades o la unidad serializada. Consulta antes los documentos vigentes de retracto, devoluciones y garantías.",
  },
  {
    question: "¿Dónde radico una petición, queja o reclamo?",
    answer:
      "Desde «Mi cuenta» entra a «Soporte» para radicar y seguir tu PQR. El centro legal también publica el procedimiento y los canales institucionales.",
  },
] as const;

function isCleanCopy(value: string): boolean {
  if (!value.trim()) return false;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127 || character === "<" || character === ">") return false;
  }
  return true;
}

function assertHelpContent(): void {
  const slugs = new Set<string>();
  const categories = new Set<string>(helpCategories.map((category) => category.id));
  for (const article of helpArticles) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.slug) || slugs.has(article.slug)) {
      throw new TypeError("Help article slugs must be unique and URL-safe.");
    }
    slugs.add(article.slug);
    if (
      !categories.has(article.category) ||
      !isCleanCopy(article.title) ||
      !isCleanCopy(article.summary) ||
      article.keywords.length === 0 ||
      article.keywords.some((keyword) => !isCleanCopy(keyword)) ||
      article.sections.length === 0
    ) {
      throw new TypeError("Help articles require a valid category and visible content.");
    }
    for (const section of article.sections) {
      if (
        !isCleanCopy(section.heading) ||
        section.paragraphs.length === 0 ||
        section.paragraphs.some((paragraph) => !isCleanCopy(paragraph)) ||
        (section.bullets ?? []).some((bullet) => !isCleanCopy(bullet))
      ) {
        throw new TypeError("Help article sections require clean non-empty text.");
      }
      for (const link of section.links ?? []) {
        if (
          !isCleanCopy(link.label) ||
          !/^\/(?!\/)[A-Za-z0-9/_?=&%.:-]+$/.test(link.href) ||
          link.href.includes("..")
        ) {
          throw new TypeError("Help article links must be safe local paths.");
        }
      }
    }
  }
  for (const article of helpArticles) {
    for (const section of article.sections) {
      for (const link of section.links ?? []) {
        if (link.href.startsWith("/ayuda/") && !slugs.has(link.href.slice("/ayuda/".length))) {
          throw new TypeError("Help article internal links must target existing guides.");
        }
      }
    }
  }
  for (const faq of helpFaqs) {
    if (!isCleanCopy(faq.question) || !isCleanCopy(faq.answer)) {
      throw new TypeError("Help FAQs require clean non-empty questions and answers.");
    }
  }
}

assertHelpContent();

export function normalizeHelpText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("es-CO")
    .replace(/\s+/g, " ")
    .trim();
}

export function isHelpCategory(value: string): value is HelpCategoryId {
  return helpCategories.some((category) => category.id === value);
}

export function getHelpArticle(slug: string): HelpArticle | undefined {
  return helpArticles.find((article) => article.slug === slug);
}

export function searchHelpArticles(input: {
  query?: string;
  category?: string;
}): readonly HelpArticle[] {
  const query = normalizeHelpText(input.query ?? "");
  const terms = query.split(" ").filter(Boolean);
  const category = input.category && isHelpCategory(input.category) ? input.category : undefined;
  return helpArticles.filter((article) => {
    if (category && article.category !== category) return false;
    const haystack = normalizeHelpText(
      [
        article.title,
        article.summary,
        ...article.keywords,
        ...article.sections.flatMap((section) => [
          section.heading,
          ...section.paragraphs,
          ...(section.bullets ?? []),
        ]),
      ].join(" "),
    );
    return terms.every((term) => haystack.includes(term));
  });
}
