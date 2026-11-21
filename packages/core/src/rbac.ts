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
  | "payments:write";

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

const permissions: Readonly<Record<AdminPermission, readonly AdminRoleValue[]>> = {
  "dashboard:read": adminRoles,
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
    | "/admin/catalogo"
    | "/admin/precios"
    | "/admin/venta-asistida"
    | "/admin/integraciones"
    | "/admin/pagos"
    | "/admin/contenido"
    | "/admin/configuracion"
    | "/admin/usuarios"
    | "/admin/seguridad"
    | "/admin/auditoria";
  label: string;
}[] {
  return [
    { href: "/admin", label: "Resumen" },
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
