export const storeConfig = {
  name: "MundoNetTech",
  domain: "mundonettech.co",
  url: "https://mundonettech.co",
  description: "Tecnología, audio, energía y accesorios multimarca en Colombia.",
  locale: "es-CO",
  countryCode: "CO",
  currency: "COP",
  timeZone: "America/Bogota",
  orderNumber: {
    prefix: "MNT",
    pattern: "MNT-YYYY-NNNN",
  },
  tax: {
    regime: "NO_RESPONSABLE_IVA",
    annualRevenueAlertUvt: 3500,
    uvtYear: 2026,
    uvtValueCents: "5237400",
  },
  checkout: {
    standardShippingCents: "0",
    deliveryPromiseDays: 30,
    reservationMinutes: 120,
  },
  modules: {
    retail: true,
    wholesale: true,
  },
} as const;

export type StoreConfig = typeof storeConfig;
