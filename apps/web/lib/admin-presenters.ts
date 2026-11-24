import type { AdminRoleValue } from "@mundonettech/core";

export const roleLabels: Record<AdminRoleValue, string> = {
  SUPERADMIN: "Superadministrador",
  OPERATIONS_MANAGER: "Dirección de operaciones",
  STORE_MANAGER: "Gestión de tienda",
  INVENTORY_BUYER: "Inventario y compras",
  FULFILLMENT: "Alistamiento y despacho",
  CUSTOMER_SUPPORT: "Servicio al cliente",
  FINANCE_ANALYST: "Análisis financiero",
  CMS_EDITOR: "Edición de contenido",
};
