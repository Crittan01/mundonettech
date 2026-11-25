import { DeliveryValidationError } from "@mundonettech/core";
import {
  CartNotFoundError,
  CheckoutAuthenticationRequiredError,
  CheckoutConflictError,
  CheckoutCouponError,
  CheckoutReviewRequiredError,
  CheckoutStockError,
  LocalDeliveryConflictError,
  LocalDeliveryValidationError,
  OrderValidationError,
  ReceiptBalanceError,
} from "@mundonettech/db";
import {
  PaymentConflictError,
  PaymentNotFoundError,
  PaymentProviderError,
  PaymentValidationError,
} from "@mundonettech/integrations";

export function checkoutMutationMessage(error: unknown): string {
  if (error instanceof PaymentConflictError) {
    if (error.code === "BLOCKED_IDENTITY") {
      return "El pago contraentrega no está disponible para tus datos de contacto. Elige otro método de pago antes de confirmar.";
    }
    if (error.code === "INSUFFICIENT_CREDIT") {
      return "Tu saldo disponible de crédito de tienda cambió. Recarga el checkout o elige otro método de pago.";
    }
    return "El método de pago seleccionado cambió de disponibilidad. Recarga el checkout y elige otra opción.";
  }
  if (
    error instanceof PaymentNotFoundError ||
    error instanceof PaymentProviderError ||
    error instanceof PaymentValidationError
  ) {
    return "No pudimos validar el método de pago seleccionado. Revisa tu selección o elige otro medio de pago.";
  }
  if (error instanceof CheckoutReviewRequiredError || error instanceof LocalDeliveryConflictError) {
    return "Los precios, impuestos o condiciones de entrega cambiaron. Recarga el checkout y revisa nuevamente antes de confirmar.";
  }
  if (error instanceof CheckoutAuthenticationRequiredError) {
    return "El correo pertenece a una cuenta registrada o no coincide con la cuenta del carrito. Inicia sesión con esa cuenta para continuar.";
  }
  if (error instanceof CheckoutStockError) {
    return "El stock cambió antes de confirmar y ya no alcanza para todo el pedido. No se creó la orden ni se descontó inventario; ajusta tu carrito.";
  }
  if (error instanceof CheckoutCouponError) {
    return "El cupón cambió, venció o alcanzó su límite. No se creó la orden; vuelve al carrito para revisar el descuento.";
  }
  if (error instanceof CheckoutConflictError) {
    return "El carrito ya fue procesado o existe una confirmación equivalente en curso. Recarga el carrito y conserva el mismo envío si necesitas reintentar.";
  }
  if (error instanceof CartNotFoundError) {
    return "El carrito ya no está disponible. Recarga la página antes de continuar.";
  }
  if (
    error instanceof OrderValidationError ||
    error instanceof LocalDeliveryValidationError ||
    error instanceof DeliveryValidationError
  ) {
    return "Revisa los datos de contacto, dirección, municipio, sede y aceptaciones. La orden no fue creada.";
  }
  if (error instanceof ReceiptBalanceError) {
    return "La validación aritmética impidió emitir el comprobante. La operación quedó bloqueada para revisión y no se confirmó parcialmente.";
  }
  return "No pudimos verificar el resultado de la confirmación. Recarga el checkout y reintenta con el mismo envío y sin cambiar los datos para recuperar la orden si ya quedó registrada.";
}
