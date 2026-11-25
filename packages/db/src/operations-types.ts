export interface DailyFunnelPoint {
  readonly metricDate: string;
  readonly pageViews: string;
  readonly productViews: string;
  readonly cartAdditions: string;
  readonly checkoutStarts: string;
  readonly ordersConfirmed: string;
  readonly ordersPaid: string;
}

export interface DashboardSnapshot {
  readonly days: DailyFunnelPoint[];
  readonly totals: Omit<DailyFunnelPoint, "metricDate">;
  readonly productToCartBps: number | null;
  readonly checkoutToOrderBps: number | null;
  readonly orderToPaidBps: number | null;
  readonly unreadNotifications: number;
}

export interface FinanceRange {
  readonly from: Date;
  readonly to: Date;
}

export interface FinanceOrderRow {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly recognizedAt: string;
  readonly currency: string;
  readonly paymentStatus: string;
  readonly capturedCents: string;
  readonly voidedCents: string;
  readonly grossCapturedCents: string;
  readonly refundedCents: string;
  readonly netRevenueCents: string;
  readonly wacCostCents: string;
  readonly marginCents: string;
}

export interface FinanceSummary {
  readonly orderCount: number;
  readonly capturedCents: string;
  readonly voidedCents: string;
  readonly grossCapturedCents: string;
  readonly refundedCents: string;
  readonly netRevenueCents: string;
  readonly wacCostCents: string;
  readonly marginCents: string;
  readonly marginBps: number | null;
}

export interface FinanceReport {
  readonly summary: FinanceSummary;
  readonly rows: FinanceOrderRow[];
}

export interface FiscalWatchView {
  readonly id: string;
  readonly fiscalYear: number;
  readonly snapshotDate: string;
  readonly uvtYear: number;
  readonly uvtValueCents: string;
  readonly thresholdUvt: number;
  readonly thresholdCents: string;
  readonly grossCapturedCents: string;
  readonly refundedCents: string;
  readonly netRevenueCents: string;
  readonly refundExcessCents: string;
  readonly remainingCents: string;
  readonly status: "WITHIN_LIMIT" | "APPROACHING_LIMIT" | "THRESHOLD_REACHED";
  readonly thresholdReachedAt: string | null;
}

export interface OperationalNotification {
  readonly id: string;
  readonly category: string;
  readonly severity: "INFO" | "WARNING" | "CRITICAL";
  readonly title: string;
  readonly message: string;
  readonly href: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly createdAt: string;
  readonly readAt: string | null;
}

export interface OperationalQueueOrder {
  readonly id: string;
  readonly orderNumber: string;
  readonly createdAt: string;
  readonly totalCents: string;
  readonly paymentStatus: string;
  readonly fulfillmentStatus: string;
  readonly recipientName: string;
}

export interface OperationalQueueShipment {
  readonly id: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly promisedAt: string;
  readonly status: string;
  readonly fulfillmentStatus: string | null;
}

export interface OperationalQueueRefund {
  readonly id: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly createdAt: string;
  readonly totalCents: string;
  readonly status: string;
}

export interface OperationalQueuePayment {
  readonly id: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly provider: string;
  readonly status: string;
  readonly amountCents: string;
  readonly createdAt: string;
}

export interface OperationsPermissions {
  readonly orders: boolean;
  readonly payments: boolean;
  readonly finance: boolean;
  readonly audit: boolean;
}

export interface OperationsSnapshot {
  readonly permissions: OperationsPermissions;
  readonly pendingOrders: OperationalQueueOrder[];
  readonly lateShipments: OperationalQueueShipment[];
  readonly pendingPayments: OperationalQueuePayment[];
  readonly pendingRefunds: OperationalQueueRefund[];
  readonly failedOutbox: number;
  readonly notifications: OperationalNotification[];
}

export interface AdminOrderListItem {
  readonly id: string;
  readonly orderNumber: string;
  readonly createdAt: string;
  readonly totalCents: string;
  readonly orderStatus: string;
  readonly paymentStatus: string;
  readonly fulfillmentStatus: string;
  readonly recipientName: string;
  readonly email: string;
  readonly itemCount: number;
}

export interface AdminOrderPage {
  readonly items: AdminOrderListItem[];
  readonly nextCursor: string | null;
}

export interface AdminSerialUnit {
  readonly id: string;
  readonly serial: string;
  readonly imei: string | null;
  readonly variantId: string;
  readonly locationId: string;
  readonly shipmentId: string | null;
  readonly status: string;
}

export interface AdminOrderDetail {
  readonly id: string;
  readonly orderNumber: string;
  readonly createdAt: string;
  readonly confirmedAt: string | null;
  readonly orderStatus: string;
  readonly paymentStatus: string;
  readonly fulfillmentStatus: string;
  readonly fulfillmentMethod: string | null;
  readonly currency: string;
  readonly subtotalCents: string;
  readonly discountCents: string;
  readonly taxCents: string;
  readonly shippingCents: string;
  readonly totalCents: string;
  readonly contact: {
    readonly email: string;
    readonly recipientName: string;
    readonly phone: string;
    readonly document: string;
    readonly address: string;
  };
  readonly items: readonly {
    readonly id: string;
    readonly variantId: string;
    readonly title: string;
    readonly sku: string;
    readonly quantity: number;
    readonly trackSerial: boolean;
    readonly unitPriceCents: string;
    readonly unitCostWacCents?: string;
    readonly discountCents: string;
    readonly taxCents: string;
    readonly lineTotalCents: string;
    readonly refundedQuantity: number;
    readonly taxes: readonly {
      readonly code: string;
      readonly rule: string;
      readonly rateBps: number;
      readonly taxCents: string;
    }[];
  }[];
  readonly payments?: readonly {
    readonly id: string;
    readonly provider: string;
    readonly status: string;
    readonly reference: string;
    readonly amountCents: string;
    readonly createdAt: string;
    readonly transactions: readonly {
      readonly id: string;
      readonly kind: string;
      readonly status: string;
      readonly amountCents: string;
      readonly externalId: string | null;
      readonly createdAt: string;
    }[];
  }[];
  readonly shipments: readonly {
    readonly id: string;
    readonly originLocationId: string;
    readonly status: string;
    readonly fulfillmentStatus: string | null;
    readonly provider: string | null;
    readonly trackingCode: string | null;
    readonly promisedAt: string;
    readonly shippedAt: string | null;
    readonly deliveredAt: string | null;
    readonly items: readonly {
      readonly id: string;
      readonly orderItemId: string;
      readonly variantId: string;
      readonly title: string;
      readonly quantity: number;
      readonly trackSerial: boolean;
    }[];
    readonly packages: readonly {
      readonly id: string;
      readonly packageNumber: number;
      readonly status: string;
      readonly trackingCode: string | null;
    }[];
  }[];
  readonly serialUnits: AdminSerialUnit[];
  readonly refunds?: readonly {
    readonly id: string;
    readonly reason: string;
    readonly status: string;
    readonly note: string | null;
    readonly subtotalCents: string;
    readonly taxCents: string;
    readonly shippingCents: string;
    readonly totalCents: string;
    readonly createdAt: string;
    readonly processedAt: string | null;
    readonly hasPostSaleLink: boolean;
    readonly items: readonly { readonly orderItemId: string; readonly quantity: number }[];
    readonly transactions: readonly {
      readonly id: string;
      readonly provider: string;
      readonly status: string;
      readonly amountCents: string;
      readonly externalId: string | null;
    }[];
  }[];
  readonly timeline: readonly {
    readonly id: string;
    readonly occurredAt: string;
    readonly orderStatus: string;
    readonly paymentStatus: string;
    readonly fulfillmentStatus: string;
    readonly reason: string | null;
  }[];
}
