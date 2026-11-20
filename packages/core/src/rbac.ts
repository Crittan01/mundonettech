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
  | "audit:read";

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

const permissions: Readonly<Record<AdminPermission, readonly AdminRoleValue[]>> = {
  "dashboard:read": adminRoles,
  "users:read": ["SUPERADMIN", "OPERATIONS_MANAGER"],
  "users:write": ["SUPERADMIN", "OPERATIONS_MANAGER"],
  "security:read_own": adminRoles,
  "security:write_own": adminRoles,
  "audit:read": ["SUPERADMIN", "OPERATIONS_MANAGER", "FINANCE_ANALYST"],
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
  href: "/admin" | "/admin/usuarios" | "/admin/seguridad" | "/admin/auditoria";
  label: string;
}[] {
  return [
    { href: "/admin", label: "Resumen" },
    ...(hasAdminPermission(role, "users:read")
      ? [{ href: "/admin/usuarios" as const, label: "Usuarios" }]
      : []),
    { href: "/admin/seguridad", label: "Seguridad" },
    ...(hasAdminPermission(role, "audit:read")
      ? [{ href: "/admin/auditoria" as const, label: "Auditoría" }]
      : []),
  ];
}
