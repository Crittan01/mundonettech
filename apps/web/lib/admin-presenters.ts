import type { AdminRoleValue } from "@mundonettech/core";
import type {
  FiscalDocumentStatus,
  FulfillmentStatus,
  OrderFulfillmentMethod,
  OrderFulfillmentStatus,
  OrderRefundReason,
  OrderRefundStatus,
  OrderStatus,
  PaymentAttemptStatus,
  PaymentProvider,
  PaymentStatus,
  PaymentTransactionKind,
  PaymentTransactionStatus,
  ReturnRequestKind,
  ReturnRequestStatus,
  ReviewStatus,
  SerializedUnitStatus,
  ShipmentPackageStatus,
  ShipmentStatus,
  ShippingProviderCode,
  SupportTicketStatus,
  WarrantyClaimStatus,
  WarrantyRemedy,
  WholesaleTierScope,
} from "@mundonettech/db";

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

export const orderStatusLabels: Record<OrderStatus, string> = {
  PENDING: "Pendiente",
  CONFIRMED: "Confirmado",
  CANCELLED: "Cancelado",
  COMPLETED: "Completado",
};

export const paymentStatusLabels: Record<PaymentStatus, string> = {
  UNPAID: "Sin pago",
  PARTIALLY_PAID: "Pago parcial",
  PAID: "Pagado",
  PARTIALLY_REFUNDED: "Reembolso parcial",
  REFUNDED: "Reembolsado",
  FAILED: "Fallido",
};

export const fulfillmentStatusLabels: Record<FulfillmentStatus, string> = {
  UNFULFILLED: "Sin despachar",
  PARTIALLY_FULFILLED: "Despacho parcial",
  FULFILLED: "Despachado",
  CANCELLED: "Cancelado",
};

export const fulfillmentMethodLabels: Record<OrderFulfillmentMethod, string> = {
  HOME_DELIVERY: "Envío nacional a domicilio",
  LOCAL_DELIVERY: "Entrega local Flex",
  CLICK_COLLECT: "Recogida en sede",
};

export const shippingProviderLabels: Record<ShippingProviderCode, string> = {
  AVEONLINE: "Aveonline",
  FLEX: "Entrega local Flex",
  PICKUP: "Recogida en sede",
};

export const shipmentStatusLabels: Record<ShipmentStatus, string> = {
  PENDING: "Pendiente",
  READY: "Listo para despacho",
  SHIPPED: "Despachado",
  DELIVERED: "Entregado",
  CANCELLED: "Cancelado",
};

export const orderFulfillmentStatusLabels: Record<OrderFulfillmentStatus, string> = {
  PENDING: "Pendiente de alistamiento",
  PICKING: "En alistamiento",
  PACKED: "Empacado",
  RECONCILING: "En conciliación de guía",
  LABELLED: "Con guía emitida",
  SHIPPED: "Despachado",
  DELIVERED: "Entregado",
  CANCELLED: "Cancelado",
};

export const shipmentPackageStatusLabels: Record<ShipmentPackageStatus, string> = {
  SEALED: "Sellado",
  CLAIMED: "Reclamando guía",
  LABELLED: "Rotulado",
  SHIPPED: "Despachado",
  DELIVERED: "Entregado",
  RECONCILING: "En conciliación de guía",
  CANCELLED: "Cancelado",
};

export const serializedUnitStatusLabels: Record<SerializedUnitStatus, string> = {
  IN_STOCK: "En bodega",
  RESERVED: "Reservado",
  SOLD: "Despachado / vendido",
  RETURNED: "Devuelto",
  QUARANTINED: "En cuarentena",
};

export const paymentProviderLabels: Record<PaymentProvider, string> = {
  WOMPI: "Wompi",
  COD: "Contraentrega",
  BANK_TRANSFER: "Transferencia bancaria",
  STORE_CREDIT: "Saldo a favor",
};

export const paymentAttemptStatusLabels: Record<PaymentAttemptStatus, string> = {
  PENDING: "Pendiente",
  PROCESSING: "Procesando",
  REQUIRES_ACTION: "Esperando cliente",
  AUTHORIZED: "Autorizado",
  SUCCEEDED: "Cobrado",
  FAILED: "Fallido",
  CANCELLED: "Cancelado",
  EXPIRED: "Expirado",
};

export const paymentTransactionKindLabels: Record<PaymentTransactionKind, string> = {
  CAPTURE: "Captura",
  VOID: "Anulación",
  REFUND: "Reembolso",
};

export const paymentTransactionStatusLabels: Record<PaymentTransactionStatus, string> = {
  PENDING: "Pendiente",
  PROCESSING: "En proceso",
  SUCCEEDED: "Completada",
  FAILED: "Fallida",
  CANCELLED: "Cancelada",
};

export const refundReasonLabels: Record<OrderRefundReason, string> = {
  RETRACT: "Retracto legal",
  WARRANTY: "Garantía",
  ADJUSTMENT: "Ajuste comercial",
  CUSTOMER_SUPPORT: "Atención al cliente",
};

export const refundStatusLabels: Record<OrderRefundStatus, string> = {
  REQUESTED: "Solicitado",
  APPROVED: "Aprobado",
  REJECTED: "Rechazado",
  PROCESSING: "En proceso",
  COMPLETED: "Completado",
  FAILED: "Fallido",
  CANCELLED: "Cancelado",
};

export const returnKindLabels: Record<ReturnRequestKind, string> = {
  REFUND: "Retracto con reembolso",
  EXCHANGE: "Cambio de variante",
};

export const returnStatusLabels: Record<ReturnRequestStatus, string> = {
  REQUESTED: "Solicitada",
  AWAITING_RETURN: "Esperando devolución",
  RECEIVED: "Recibida en bodega",
  COMPLETED: "Completada",
  REJECTED: "Rechazada",
  CANCELLED: "Cancelada",
};

export const warrantyRemedyLabels: Record<WarrantyRemedy, string> = {
  REPAIR: "Diagnóstico y reparación",
  REPLACEMENT: "Reemplazo de unidad",
  REFUND: "Reembolso",
};

export const warrantyStatusLabels: Record<WarrantyClaimStatus, string> = {
  REQUESTED: "Solicitada",
  UNDER_REVIEW: "En revisión técnica",
  APPROVED: "Aprobada",
  RESOLVED: "Resuelta",
  REJECTED: "Rechazada",
  CANCELLED: "Cancelada",
};

export const supportTicketStatusLabels: Record<SupportTicketStatus, string> = {
  OPEN: "Abierta",
  IN_PROGRESS: "En gestión",
  WAITING_CUSTOMER: "Esperando cliente",
  RESOLVED: "Resuelta",
  CLOSED: "Cerrada",
};

export const reviewStatusLabels: Record<ReviewStatus, string> = {
  PENDING: "Pendiente de moderación",
  PUBLISHED: "Publicada",
  REJECTED: "Rechazada",
};

export const fiscalDocStatusLabels: Record<FiscalDocumentStatus, string> = {
  DRAFT: "Borrador",
  TRANSMITTING: "Transmitiendo",
  ACCEPTED: "Aceptado por DIAN",
  REJECTED: "Rechazado por DIAN",
  UNCERTAIN: "Estado incierto (conciliar)",
  CANCELLED: "Cancelado",
};

export const productStatusLabels: Record<"DRAFT" | "ACTIVE" | "ARCHIVED", string> = {
  DRAFT: "Borrador",
  ACTIVE: "Activo",
  ARCHIVED: "Archivado",
};

export const variantStatusLabels: Record<"ACTIVE" | "INACTIVE", string> = {
  ACTIVE: "Activa",
  INACTIVE: "Inactiva",
};

export const wholesaleScopeLabels: Record<WholesaleTierScope, string> = {
  GLOBAL: "Global",
  CATEGORY: "Por categoría",
  PRODUCT: "Por producto",
  VARIANT: "Por variante",
};

export const taxRuleLabels: Record<string, string> = {
  NOT_RESPONSABLE: "No responsable de IVA",
  STANDARD: "Tarifa general",
  EXEMPT: "Exento (0 %)",
  EXCLUDED: "Excluido",
  UVT_EXCLUDED_WITHIN_LIMIT: "Excluido dentro del tope UVT",
  UVT_STANDARD_ABOVE_LIMIT: "Gravado por superar tope UVT",
};

export const emailTopicLabels: Record<string, string> = {
  orders: "Pedidos",
  shipping: "Envíos",
  fulfillment: "Logística",
  fiscal: "Facturación DIAN",
  postsale: "Posventa y RMA",
  "cart-recovery": "Recuperación de carrito",
  lifecycle: "Ciclo de vida",
  support: "Soporte y PQR",
};

export const emailTemplateLabels: Record<string, string> = {
  "order.confirmed": "Confirmación de pedido",
  "order.paid": "Pago confirmado",
  "shipment.shipped": "Pedido despachado",
  "shipment.delivered": "Pedido entregado",
  "invoice.accepted": "Factura electrónica disponible",
  "credit-note.accepted": "Nota crédito disponible",
  "refund.completed": "Reembolso confirmado",
  "postsale.updated": "Actualización de posventa",
  "cart.recovery": "Recordatorio de carrito",
  "lifecycle.campaign": "Campaña de ciclo de vida",
  "support.ticket": "Actualización de PQR",
};

export const securityEventLabels: Record<string, string> = {
  ADMIN_LOGIN_SUCCEEDED: "Inicio de sesión administrativo exitoso",
  ADMIN_LOGIN_FAILED: "Intento fallido de inicio de sesión",
  ADMIN_MFA_VERIFIED: "Segundo factor TOTP verificado",
  ADMIN_MFA_FAILED: "Código de segundo factor rechazado",
  ADMIN_STEP_UP_VERIFIED: "Identidad confirmada (step-up MFA)",
  ADMIN_STEP_UP_FAILED: "Fallo al confirmar identidad (step-up MFA)",
  ADMIN_RECOVERY_CODE_USED: "Autenticador restablecido con código de recuperación",
  ADMIN_RECOVERY_CODE_FAILED: "Código de recuperación rechazado",
  ADMIN_RECOVERY_CODES_REGENERATED: "Códigos de recuperación regenerados",
  ADMIN_SESSIONS_REVOKED_ALL: "Cierre global de sesiones administrativas",
  ADMIN_INVITATION_ACCEPTED: "Invitación administrativa activada",
  ADMIN_INVITATION_FAILED: "Intento fallido de activación de invitación",
};

export const crmSourceLabels: Record<string, string> = {
  "admin-crm": "Consola CRM",
  checkout: "Finalización de compra",
  "storefront-b2b": "Formulario empresarial",
  "customer-account": "Cuenta del cliente",
};

export const integrationProviderLabels: Record<string, string> = {
  wompi: "Wompi",
  aveonline: "Aveonline",
  resend: "Resend",
  dian: "DIAN",
  gemini: "Google Gemini",
  meta: "Meta Conversions API",
  "mercado-libre": "Mercado Libre",
};

const orderEventReasonLabels: Record<string, string> = {
  CHECKOUT_CONFIRMED: "Pedido confirmado en compra",
  B2B_PROPOSAL_ACCEPTED: "Propuesta B2B aceptada y convertida",
  PAYMENT_LEDGER_UPDATED: "Actualización del libro de pagos",
  RESERVATION_EXPIRED: "Reserva vencida sin pago",
  "Carrier or Flex dispatch confirmed": "Despacho confirmado en logística",
  "Delivery confirmed": "Entrega confirmada",
};

export function formatOrderEventReason(reason: string | null | undefined): string {
  if (!reason) return "Actualización operativa";
  return orderEventReasonLabels[reason] ?? reason;
}
