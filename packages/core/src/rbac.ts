export const adminRoles = [
  "SUPERADMIN",
  "OPERATIONS_MANAGER",
  "STORE_MANAGER",
  "INVENTORY_BUYER",
  "FULFILLMENT",
  "CUSTOMER_SUPPORT",
  "FINANCE_ANALYST",
  "CMS_EDITOR",
] as const;

export type AdminRoleValue = (typeof adminRoles)[number];
export type AdminRing = 1 | 2 | 3;
export type AdminPermission =
  | "dashboard:read"
  | "orders:read"
  | "postsale:read"
  | "postsale:write"
  | "crm:read"
  | "crm:write"
  | "crm:merge"
  | "crm:suppress"
  | "reviews:read"
  | "reviews:write"
  | "finance:read"
  | "users:read"
  | "users:write"
  | "security:read_own"
  | "security:write_own"
  | "audit:read"
  | "catalog:read"
  | "catalog:write"
  | "content:read"
  | "content:write"
  | "settings:read"
  | "settings:write"
  | "pricing:read"
  | "pricing:write"
  | "sales:read"
  | "sales:write"
  | "integrations:read"
  | "integrations:write"
  | "payments:read"
  | "payments:write"
  | "fulfillment:read"
  | "fulfillment:write"
  | "communications:read"
  | "communications:write"
  | "invoices:read"
  | "invoices:write";

const rings: Readonly<Record<AdminRoleValue, AdminRing>> = {
  SUPERADMIN: 1,
  OPERATIONS_MANAGER: 1,
  STORE_MANAGER: 2,
  INVENTORY_BUYER: 2,
  FINANCE_ANALYST: 2,
  FULFILLMENT: 3,
  CUSTOMER_SUPPORT: 3,
  CMS_EDITOR: 3,
};

const catalogReaders = [
  "SUPERADMIN",
  "OPERATIONS_MANAGER",
  "STORE_MANAGER",
  "INVENTORY_BUYER",
  "CMS_EDITOR",
] as const satisfies readonly AdminRoleValue[];
const catalogWriters = [
  "SUPERADMIN",
  "OPERATIONS_MANAGER",
  "STORE_MANAGER",
  "INVENTORY_BUYER",
] as const satisfies readonly AdminRoleValue[];
const contentReaders = [
  "SUPERADMIN",
  "OPERATIONS_MANAGER",
  "STORE_MANAGER",
  "CMS_EDITOR",
] as const satisfies readonly AdminRoleValue[];
const contentWriters = contentReaders;
const settingsReaders = [
  "SUPERADMIN",
  "OPERATIONS_MANAGER",
  "STORE_MANAGER",
  "FINANCE_ANALYST",
] as const satisfies readonly AdminRoleValue[];
const settingsWriters = [
  "SUPERADMIN",
  "OPERATIONS_MANAGER",
  "STORE_MANAGER",
] as const satisfies readonly AdminRoleValue[];
const pricingReaders = [
  "SUPERADMIN",
  "OPERATIONS_MANAGER",
  "STORE_MANAGER",
  "INVENTORY_BUYER",
  "FINANCE_ANALYST",
] as const satisfies readonly AdminRoleValue[];
const pricingWriters = [
  "SUPERADMIN",
  "OPERATIONS_MANAGER",
  "STORE_MANAGER",
] as const satisfies readonly AdminRoleValue[];
const salesReaders = [
  "SUPERADMIN",
  "OPERATIONS_MANAGER",
  "STORE_MANAGER",
  "CUSTOMER_SUPPORT",
] as const satisfies readonly AdminRoleValue[];
const salesWriters = salesReaders;
const orderReaders = [
  "SUPERADMIN",
  "OPERATIONS_MANAGER",
  "STORE_MANAGER",
  "INVENTORY_BUYER",
  "FULFILLMENT",
  "CUSTOMER_SUPPORT",
  "FINANCE_ANALYST",
] as const satisfies readonly AdminRoleValue[];
const postsaleWriters = [
  "SUPERADMIN",
  "OPERATIONS_MANAGER",
  "STORE_MANAGER",
  "CUSTOMER_SUPPORT",
] as const satisfies readonly AdminRoleValue[];
const crmReaders = [
  "SUPERADMIN",
  "OPERATIONS_MANAGER",
  "STORE_MANAGER",
  "CUSTOMER_SUPPORT",
  "FINANCE_ANALYST",
] as const satisfies readonly AdminRoleValue[];
const crmWriters = postsaleWriters;
const crmSensitiveWriters = [
  "SUPERADMIN",
  "OPERATIONS_MANAGER",
] as const satisfies readonly AdminRoleValue[];
const reviewReaders = [...orderReaders, "CMS_EDITOR"] as const satisfies readonly AdminRoleValue[];
const reviewWriters = [
  ...postsaleWriters,
  "CMS_EDITOR",
] as const satisfies readonly AdminRoleValue[];
const integrationReaders = [
  "SUPERADMIN",
  "OPERATIONS_MANAGER",
  "FINANCE_ANALYST",
] as const satisfies readonly AdminRoleValue[];
const integrationWriters = [
  "SUPERADMIN",
  "OPERATIONS_MANAGER",
] as const satisfies readonly AdminRoleValue[];
const paymentReaders = [
  "SUPERADMIN",
  "OPERATIONS_MANAGER",
  "STORE_MANAGER",
  "CUSTOMER_SUPPORT",
  "FINANCE_ANALYST",
] as const satisfies readonly AdminRoleValue[];
const paymentWriters = integrationReaders;
const fulfillmentReaders = [
  "SUPERADMIN",
  "OPERATIONS_MANAGER",
  "STORE_MANAGER",
  "INVENTORY_BUYER",
  "FULFILLMENT",
  "CUSTOMER_SUPPORT",
] as const satisfies readonly AdminRoleValue[];
const fulfillmentWriters = [
  "SUPERADMIN",
  "OPERATIONS_MANAGER",
  "STORE_MANAGER",
  "FULFILLMENT",
] as const satisfies readonly AdminRoleValue[];
const communicationReaders = [
  "SUPERADMIN",
  "OPERATIONS_MANAGER",
  "STORE_MANAGER",
  "CUSTOMER_SUPPORT",
] as const satisfies readonly AdminRoleValue[];
const communicationWriters = [
  "SUPERADMIN",
  "OPERATIONS_MANAGER",
  "STORE_MANAGER",
] as const satisfies readonly AdminRoleValue[];
const invoiceReaders = [
  "SUPERADMIN",
  "OPERATIONS_MANAGER",
  "STORE_MANAGER",
  "CUSTOMER_SUPPORT",
  "FINANCE_ANALYST",
] as const satisfies readonly AdminRoleValue[];
const invoiceWriters = [
  "SUPERADMIN",
  "OPERATIONS_MANAGER",
  "FINANCE_ANALYST",
] as const satisfies readonly AdminRoleValue[];

const permissions: Readonly<Record<AdminPermission, readonly AdminRoleValue[]>> = {
  "dashboard:read": adminRoles,
  "orders:read": orderReaders,
  "postsale:read": orderReaders,
  "postsale:write": postsaleWriters,
  "crm:read": crmReaders,
  "crm:write": crmWriters,
  "crm:merge": crmSensitiveWriters,
  "crm:suppress": crmSensitiveWriters,
  "reviews:read": reviewReaders,
  "reviews:write": reviewWriters,
  "finance:read": integrationReaders,
  "users:read": ["SUPERADMIN", "OPERATIONS_MANAGER"],
  "users:write": ["SUPERADMIN", "OPERATIONS_MANAGER"],
  "security:read_own": adminRoles,
  "security:write_own": adminRoles,
  "audit:read": ["SUPERADMIN", "OPERATIONS_MANAGER", "FINANCE_ANALYST"],
  "catalog:read": catalogReaders,
  "catalog:write": catalogWriters,
  "content:read": contentReaders,
  "content:write": contentWriters,
  "settings:read": settingsReaders,
  "settings:write": settingsWriters,
  "pricing:read": pricingReaders,
  "pricing:write": pricingWriters,
  "sales:read": salesReaders,
  "sales:write": salesWriters,
  "integrations:read": integrationReaders,
  "integrations:write": integrationWriters,
  "payments:read": paymentReaders,
  "payments:write": paymentWriters,
  "fulfillment:read": fulfillmentReaders,
  "fulfillment:write": fulfillmentWriters,
  "communications:read": communicationReaders,
  "communications:write": communicationWriters,
  "invoices:read": invoiceReaders,
  "invoices:write": invoiceWriters,
};

export function isAdminRole(value: unknown): value is AdminRoleValue {
  return typeof value === "string" && adminRoles.includes(value as AdminRoleValue);
}

export function adminRing(role: AdminRoleValue): AdminRing {
  return rings[role];
}

export function hasAdminPermission(role: AdminRoleValue, permission: AdminPermission): boolean {
  return permissions[permission].includes(role);
}

export function assertAdminPermission(role: AdminRoleValue, permission: AdminPermission): void {
  if (!hasAdminPermission(role, permission)) {
    throw new Error("The current administrator is not authorized for this operation.");
  }
}

export function canAssignAdminRole(actorRole: AdminRoleValue, targetRole: AdminRoleValue): boolean {
  if (actorRole === "SUPERADMIN") return true;
  return actorRole === "OPERATIONS_MANAGER" && adminRing(targetRole) !== 1;
}

export function canManageAdministrator(
  actorRole: AdminRoleValue,
  targetRole: AdminRoleValue,
): boolean {
  if (actorRole === "SUPERADMIN") return true;
  return actorRole === "OPERATIONS_MANAGER" && adminRing(targetRole) !== 1;
}

export function adminNavigation(role: AdminRoleValue): readonly {
  href:
    | "/admin"
    | "/admin/hoy"
    | "/admin/dashboard"
    | "/admin/pedidos"
    | "/admin/posventa"
    | "/admin/crm"
    | "/admin/resenas"
    | "/admin/finanzas"
    | "/admin/catalogo"
    | "/admin/precios"
    | "/admin/venta-asistida"
    | "/admin/integraciones"
    | "/admin/pagos"
    | "/admin/logistica"
    | "/admin/comunicaciones"
    | "/admin/facturacion"
    | "/admin/contenido"
    | "/admin/configuracion"
    | "/admin/usuarios"
    | "/admin/seguridad"
    | "/admin/auditoria";
  label: string;
}[] {
  return [
    { href: "/admin", label: "Resumen" },
    { href: "/admin/hoy", label: "Hoy" },
    { href: "/admin/dashboard", label: "Embudo" },
    ...(hasAdminPermission(role, "orders:read")
      ? [{ href: "/admin/pedidos" as const, label: "Pedidos" }]
      : []),
    ...(hasAdminPermission(role, "postsale:read")
      ? [{ href: "/admin/posventa" as const, label: "Posventa" }]
      : []),
    ...(hasAdminPermission(role, "crm:read")
      ? [{ href: "/admin/crm" as const, label: "CRM 360" }]
      : []),
    ...(hasAdminPermission(role, "reviews:read")
      ? [{ href: "/admin/resenas" as const, label: "Reseñas" }]
      : []),
    ...(hasAdminPermission(role, "finance:read")
      ? [{ href: "/admin/finanzas" as const, label: "Finanzas" }]
      : []),
    ...(hasAdminPermission(role, "catalog:read")
      ? [{ href: "/admin/catalogo" as const, label: "Catálogo" }]
      : []),
    ...(hasAdminPermission(role, "pricing:read")
      ? [{ href: "/admin/precios" as const, label: "Precios" }]
      : []),
    ...(hasAdminPermission(role, "sales:read")
      ? [{ href: "/admin/venta-asistida" as const, label: "Venta asistida" }]
      : []),
    ...(hasAdminPermission(role, "integrations:read")
      ? [{ href: "/admin/integraciones" as const, label: "Integraciones" }]
      : []),
    ...(hasAdminPermission(role, "payments:read")
      ? [{ href: "/admin/pagos" as const, label: "Pagos" }]
      : []),
    ...(hasAdminPermission(role, "fulfillment:read")
      ? [{ href: "/admin/logistica" as const, label: "Logística" }]
      : []),
    ...(hasAdminPermission(role, "communications:read")
      ? [{ href: "/admin/comunicaciones" as const, label: "Comunicaciones" }]
      : []),
    ...(hasAdminPermission(role, "invoices:read")
      ? [{ href: "/admin/facturacion" as const, label: "Facturación" }]
      : []),
    ...(hasAdminPermission(role, "content:read")
      ? [{ href: "/admin/contenido" as const, label: "Contenido" }]
      : []),
    ...(hasAdminPermission(role, "settings:read")
      ? [{ href: "/admin/configuracion" as const, label: "Configuración" }]
      : []),
    ...(hasAdminPermission(role, "users:read")
      ? [{ href: "/admin/usuarios" as const, label: "Usuarios" }]
      : []),
    { href: "/admin/seguridad", label: "Seguridad" },
    ...(hasAdminPermission(role, "audit:read")
      ? [{ href: "/admin/auditoria" as const, label: "Auditoría" }]
      : []),
  ];
}
