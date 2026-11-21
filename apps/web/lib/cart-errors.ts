import {
  CartNotFoundError,
  CartStateError,
  CartStockError,
  CartValidationError,
  CouponError,
} from "@mundonettech/db";

export function cartMutationMessage(error: unknown): string {
  if (error instanceof CouponError) {
    switch (error.code) {
      case "INVALID_CODE":
        return "El código debe tener entre 2 y 64 letras, números, guiones o guiones bajos.";
      case "NOT_FOUND":
        return "No encontramos ese cupón. Revisa el código e inténtalo de nuevo.";
      case "INACTIVE":
      case "SCHEDULE":
        return "Este cupón no está vigente.";
      case "MAXIMUM_USAGES":
        return "Este cupón ya alcanzó su límite total de uso.";
      case "CUSTOMER_USAGES":
        return "Tu cuenta ya alcanzó el límite permitido para este cupón.";
      case "MINIMUM_SUBTOTAL":
        return "El subtotal con descuentos comerciales no alcanza el mínimo del cupón.";
      case "NO_ELIGIBLE_ITEMS":
        return "Ningún producto del carrito cumple las restricciones de este cupón.";
      case "EMPTY_CART":
        return "Añade productos antes de aplicar un cupón.";
    }
  }
  if (error instanceof CartStockError) {
    return error.available === 0
      ? "No quedan unidades vendibles de ese producto. Ajusta las cantidades o elimina el paquete."
      : `La cantidad supera el stock efectivo disponible${error.available === null ? "" : ` (${error.available} unidades)`}. Revisa también las unidades incluidas en paquetes.`;
  }
  if (error instanceof CartNotFoundError) {
    return "El carrito o la línea solicitada ya no está disponible. Recarga la página.";
  }
  if (error instanceof CartStateError) {
    return "El carrito cambió de estado o requiere revisar un paquete antes de continuar. Recarga y ajusta lo indicado.";
  }
  if (error instanceof CartValidationError) {
    return "Los datos del carrito no son válidos o el producto ya no está disponible.";
  }
  return "No pudimos actualizar el carrito. Inténtalo de nuevo; la operación no se aplicó parcialmente.";
}
