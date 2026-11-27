export interface AdminNavItem {
  readonly href: string;
  readonly label: string;
}

export interface AdminNavGroup {
  readonly id: string;
  readonly title: string;
  readonly items: readonly AdminNavItem[];
}

export interface AdminNavMetadata {
  readonly groupId: string;
  readonly groupTitle: string;
  readonly description: string;
  readonly keywords: readonly string[];
}

const groupOrder = [
  { id: "operacion", title: "Operación diaria" },
  { id: "comercial", title: "Comercial y catálogo" },
  { id: "pedidos", title: "Pedidos y posventa" },
  { id: "clientes", title: "Clientes y crecimiento" },
  { id: "finanzas", title: "Finanzas y contenido" },
  { id: "sistema", title: "Sistema y control" },
] as const;

const itemMetadataByHref: Readonly<Record<string, AdminNavMetadata>> = {
  "/admin": {
    groupId: "operacion",
    groupTitle: "Operación diaria",
    description: "Indicadores de sesión, seguridad y accesos rápidos.",
    keywords: ["inicio", "resumen", "panel", "home"],
  },
  "/admin/hoy": {
    groupId: "operacion",
    groupTitle: "Operación diaria",
    description: "Alertas priorizadas, colas operativas y tareas del día.",
    keywords: ["alertas", "cola", "pendientes", "notificaciones"],
  },
  "/admin/dashboard": {
    groupId: "operacion",
    groupTitle: "Operación diaria",
    description: "Embudo diario agregado sin cookies ni telemetría PII.",
    keywords: ["metricas", "embudo", "funnel", "conversion"],
  },
  "/admin/catalogo": {
    groupId: "comercial",
    groupTitle: "Comercial y catálogo",
    description: "Productos, variantes, medios R2, atributos y compatibilidad.",
    keywords: ["productos", "sku", "variantes", "inventario", "stock"],
  },
  "/admin/precios": {
    groupId: "comercial",
    groupTitle: "Comercial y catálogo",
    description: "Precios mayoristas, cupones y paquetes promocionales.",
    keywords: ["cupones", "descuentos", "mayorista", "bundles", "tarifas"],
  },
  "/admin/venta-asistida": {
    groupId: "comercial",
    groupTitle: "Comercial y catálogo",
    description: "Carritos asistidos y enlaces de pago de un solo uso.",
    keywords: ["enlaces", "pagar", "vendedor", "cotizacion"],
  },
  "/admin/b2b": {
    groupId: "comercial",
    groupTitle: "Comercial y catálogo",
    description: "Listas de precios corporativas, oportunidades y propuestas B2B.",
    keywords: ["empresas", "propuestas", "corporativo", "mayoristas", "copiloto"],
  },
  "/admin/canales": {
    groupId: "comercial",
    groupTitle: "Comercial y catálogo",
    description: "Mercado Libre MCO, User Products, ofertas y sincronización.",
    keywords: ["mercado libre", "meli", "omnicanal", "mco", "publicaciones"],
  },
  "/admin/pedidos": {
    groupId: "pedidos",
    groupTitle: "Pedidos y posventa",
    description: "Órdenes retail y B2B, recibos, reservas y reembolsos.",
    keywords: ["ordenes", "compras", "recibos", "reembolsos"],
  },
  "/admin/logistica": {
    groupId: "pedidos",
    groupTitle: "Pedidos y posventa",
    description: "Alistamiento, empaque multi-bulto, guías, seriales y zonas Flex.",
    keywords: ["envios", "guias", "seriales", "imei", "despacho", "flex", "bodega"],
  },
  "/admin/pagos": {
    groupId: "pedidos",
    groupTitle: "Pedidos y posventa",
    description: "Wompi, transferencias, contraentrega, crédito y reembolsos.",
    keywords: ["wompi", "cod", "transferencia", "credito", "cobros"],
  },
  "/admin/facturacion": {
    groupId: "pedidos",
    groupTitle: "Pedidos y posventa",
    description: "Facturación electrónica DIAN UBL 2.1 y notas crédito.",
    keywords: ["dian", "facturas", "cufe", "notas credito", "ubl"],
  },
  "/admin/posventa": {
    groupId: "pedidos",
    groupTitle: "Pedidos y posventa",
    description: "Retractos, cambios, garantías serializadas y tickets PQR.",
    keywords: ["rma", "retracto", "garantias", "devoluciones", "pqr", "soporte"],
  },
  "/admin/resenas": {
    groupId: "pedidos",
    groupTitle: "Pedidos y posventa",
    description: "Moderación MFA de reseñas de compras entregadas.",
    keywords: ["calificaciones", "opiniones", "moderacion"],
  },
  "/admin/crm": {
    groupId: "clientes",
    groupTitle: "Clientes y crecimiento",
    description: "Organizaciones, contactos 360, duplicados, tareas y retención.",
    keywords: ["contactos", "clientes", "organizaciones", "duplicados", "habeas data"],
  },
  "/admin/fidelizacion": {
    groupId: "clientes",
    groupTitle: "Clientes y crecimiento",
    description: "Puntos de lealtad, referidos y recuperación de carritos.",
    keywords: ["puntos", "referidos", "carritos abandonados", "beneficios"],
  },
  "/admin/segmentos": {
    groupId: "clientes",
    groupTitle: "Clientes y crecimiento",
    description: "Segmentación auditable con evidencia de consentimiento.",
    keywords: ["audiencias", "consentimiento", "filtros"],
  },
  "/admin/lifecycle": {
    groupId: "clientes",
    groupTitle: "Clientes y crecimiento",
    description: "Journeys automatizados de ciclo de vida y mensajes sellados.",
    keywords: ["journeys", "automatizacion", "mensajes", "correos"],
  },
  "/admin/comunicaciones": {
    groupId: "clientes",
    groupTitle: "Clientes y crecimiento",
    description: "Plantillas transaccionales de correo y bajas RFC 8058.",
    keywords: ["emails", "plantillas", "resend", "correos"],
  },
  "/admin/finanzas": {
    groupId: "finanzas",
    groupTitle: "Finanzas y contenido",
    description: "Ingresos netos, WAC, margen, vigilancia 3.500 UVT y CSV.",
    keywords: ["uvt", "margen", "wac", "ingresos", "reportes", "csv"],
  },
  "/admin/analitica-rfm": {
    groupId: "finanzas",
    groupTitle: "Finanzas y contenido",
    description: "Recencia, frecuencia y LTV financiero neto en COP.",
    keywords: ["rfm", "ltv", "valor cliente", "analitica"],
  },
  "/admin/contenido": {
    groupId: "finanzas",
    groupTitle: "Finanzas y contenido",
    description: "Páginas CMS v3 por bloques, versiones y programación.",
    keywords: ["cms", "paginas", "editorial", "bloques"],
  },
  "/admin/contenido/medios": {
    groupId: "finanzas",
    groupTitle: "Finanzas y contenido",
    description: "Mediateca R2 validada y activos editoriales.",
    keywords: ["imagenes", "archivos", "r2", "galeria"],
  },
  "/admin/contenido/redirecciones": {
    groupId: "finanzas",
    groupTitle: "Finanzas y contenido",
    description: "Grafo auditado de redirecciones 301/302/307/308.",
    keywords: ["redirects", "urls", "seo", "301"],
  },
  "/admin/configuracion": {
    groupId: "sistema",
    groupTitle: "Sistema y control",
    description: "Parámetros operativos, fiscales y de tienda.",
    keywords: ["ajustes", "settings", "impuestos", "regimen"],
  },
  "/admin/integraciones": {
    groupId: "sistema",
    groupTitle: "Sistema y control",
    description: "Bóveda AES-256-GCM, feeds Merchant/Meta y CAPI.",
    keywords: ["boveda", "credenciales", "meta", "capi", "feeds", "wompi"],
  },
  "/admin/usuarios": {
    groupId: "sistema",
    groupTitle: "Sistema y control",
    description: "Administradores, invitaciones, roles y anillos RBAC.",
    keywords: ["rbac", "roles", "invitaciones", "operadores", "equipo"],
  },
  "/admin/seguridad": {
    groupId: "sistema",
    groupTitle: "Sistema y control",
    description: "Autenticador TOTP aal2, códigos de recuperación y sesiones.",
    keywords: ["mfa", "totp", "sesiones", "step-up", "recuperacion"],
  },
  "/admin/auditoria": {
    groupId: "sistema",
    groupTitle: "Sistema y control",
    description: "Registro inmutable de acciones administrativas y selfDealing.",
    keywords: ["logs", "trazabilidad", "eventos", "cumplimiento"],
  },
  "/admin/salud": {
    groupId: "sistema",
    groupTitle: "Sistema y control",
    description: "Salud operativa agregada, respaldos GPG R2 y simulacros DR.",
    keywords: ["backups", "dr", "recuperacion", "monitoreo", "estado"],
  },
};

export function isAdminNavItemActive(
  pathname: string,
  href: string,
  allHrefs: readonly string[],
): boolean {
  if (pathname === href) return true;
  if (href === "/admin") return false;
  if (!pathname.startsWith(`${href}/`)) return false;
  return !allHrefs.some(
    (other) =>
      other !== href &&
      other.length > href.length &&
      (pathname === other || pathname.startsWith(`${other}/`)),
  );
}

export function groupAdminNavigation(items: readonly AdminNavItem[]): readonly AdminNavGroup[] {
  const buckets = new Map<string, AdminNavItem[]>();
  const otherItems: AdminNavItem[] = [];

  for (const item of items) {
    const meta = itemMetadataByHref[item.href];
    if (!meta) {
      otherItems.push(item);
      continue;
    }
    const bucket = buckets.get(meta.groupId);
    if (bucket) {
      bucket.push(item);
    } else {
      buckets.set(meta.groupId, [item]);
    }
  }

  const groups: AdminNavGroup[] = [];
  for (const group of groupOrder) {
    const groupItems = buckets.get(group.id);
    if (groupItems && groupItems.length > 0) {
      groups.push({ id: group.id, title: group.title, items: groupItems });
    }
  }

  if (otherItems.length > 0) {
    groups.push({ id: "otros", title: "Otros módulos", items: otherItems });
  }

  return groups;
}

export function getAdminNavMetadata(href: string): AdminNavMetadata {
  return (
    itemMetadataByHref[href] ?? {
      groupId: "otros",
      groupTitle: "Administración",
      description: "Módulo administrativo autorizado.",
      keywords: [],
    }
  );
}

export function normalizeAdminSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function resolveAdminBreadcrumb(
  pathname: string | null,
  items: readonly AdminNavItem[],
): {
  readonly groupTitle: string;
  readonly itemLabel: string;
  readonly subLabel: string | null;
} {
  if (!pathname) {
    return { groupTitle: "Operación diaria", itemLabel: "Panel", subLabel: null };
  }
  const allHrefs = items.map((item) => item.href);
  const active = items.find((item) => isAdminNavItemActive(pathname, item.href, allHrefs));
  if (!active) {
    return { groupTitle: "Administración", itemLabel: "Sección", subLabel: null };
  }
  const meta = getAdminNavMetadata(active.href);
  let subLabel: string | null = null;
  if (pathname !== active.href && pathname.startsWith(`${active.href}/`)) {
    const remainder = pathname.slice(active.href.length + 1);
    if (remainder === "nuevo") {
      subLabel = "Nuevo registro";
    } else if (remainder.startsWith("cupones/")) {
      subLabel = "Detalle de cupón";
    } else {
      subLabel = "Detalle";
    }
  }
  return {
    groupTitle: meta.groupTitle,
    itemLabel: active.label,
    subLabel,
  };
}
