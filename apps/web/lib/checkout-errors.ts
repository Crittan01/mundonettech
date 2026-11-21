import {
  CartNotFoundError,
  CheckoutAuthenticationRequiredError,
  CheckoutConflictError,
  CheckoutCouponError,
  CheckoutReviewRequiredError,
  CheckoutStockError,
  OrderValidationError,
  ReceiptBalanceError,
} from "@mundonettech/db";

export function checkoutMutationMessage(error: unknown): string {
  if (error instanceof CheckoutReviewRequiredError) {
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
  if (error instanceof OrderValidationError) {
    return "Revisa los datos de contacto, dirección, municipio, sede y aceptaciones. La orden no fue creada.";
  }
  if (error instanceof ReceiptBalanceError) {
    return "La validación aritmética impidió emitir el comprobante. La operación quedó bloqueada para revisión y no se confirmó parcialmente.";
  }
  return "No pudimos confirmar el pedido. La operación no quedó aplicada parcialmente; inténtalo de nuevo con los mismos datos.";
}
