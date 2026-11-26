import {
  CartNotFoundError,
  CartStateError,
  CartStockError,
  CartValidationError,
  CouponError,
} from "@mundonettech/db";

export function cartMutationMessage(
  error: unknown,
  audience: "customer" | "admin" = "customer",
): string {
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
        return audience === "admin"
          ? "La cuenta del cliente ya alcanzó el límite permitido para este cupón."
          : "Tu cuenta ya alcanzó el límite permitido para este cupón.";
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
    return audience === "admin"
      ? "El carrito o la línea solicitada ya no está disponible. Recarga la vista."
      : "Tu carrito o el producto seleccionado ya no está disponible. Recarga la página.";
  }
  if (error instanceof CartStateError) {
    if (error.message.includes("assigned customer")) {
      return audience === "admin"
        ? "Esta venta asistida está asignada a una cuenta específica."
        : "Inicia sesión con la cuenta asociada a esta venta asistida antes de aceptarla.";
    }
    if (error.message.includes("already been claimed")) {
      return audience === "admin"
        ? "El cliente ya aceptó esta venta asistida; no admite nuevos cambios desde consola."
        : "Ya aceptaste esta venta asistida; este enlace ya no está disponible.";
    }
    return audience === "admin"
      ? "El carrito cambió de estado o requiere revisar un paquete antes de continuar."
      : "Tu carrito cambió de estado o requiere revisar un paquete antes de continuar. Recarga la página y ajusta lo indicado.";
  }
  if (error instanceof CartValidationError) {
    return audience === "admin"
      ? "Los datos del carrito no son válidos o el producto ya no está disponible."
      : "No pudimos validar el cambio porque el producto o paquete ya no está disponible.";
  }
  return "No pudimos actualizar el carrito. Inténtalo de nuevo; la operación no se aplicó parcialmente.";
}
