export const catalogBlueprint = {
  brands: [
    { slug: "apple", name: "Apple" },
    { slug: "samsung", name: "Samsung" },
    { slug: "logitech", name: "Logitech" },
    { slug: "sony", name: "Sony" },
    { slug: "jbl", name: "JBL" },
    { slug: "xiaomi", name: "Xiaomi" },
    { slug: "anker", name: "Anker" },
    { slug: "lenovo", name: "Lenovo" },
    { slug: "hp", name: "HP" },
    { slug: "asus", name: "ASUS" },
  ],
  categories: [
    {
      slug: "computadores",
      name: "Computadores",
      externalCategoryMap: {},
      children: [
        {
          slug: "portatiles",
          name: "Portátiles",
          externalCategoryMap: {},
          children: [
            { slug: "ultrabooks", name: "Ultrabooks", externalCategoryMap: {}, children: [] },
          ],
        },
        { slug: "monitores", name: "Monitores", externalCategoryMap: {}, children: [] },
        { slug: "tabletas", name: "Tabletas", externalCategoryMap: {}, children: [] },
      ],
    },
    {
      slug: "audio",
      name: "Audio",
      externalCategoryMap: {},
      children: [
        { slug: "audifonos", name: "Audífonos", externalCategoryMap: {}, children: [] },
        { slug: "parlantes", name: "Parlantes", externalCategoryMap: {}, children: [] },
      ],
    },
    { slug: "wearables", name: "Wearables", externalCategoryMap: {}, children: [] },
    {
      slug: "energia-y-carga",
      name: "Energía y carga",
      externalCategoryMap: {},
      children: [{ slug: "cargadores", name: "Cargadores", externalCategoryMap: {}, children: [] }],
    },
    { slug: "accesorios", name: "Accesorios", externalCategoryMap: {}, children: [] },
  ],
  attributes: [
    { key: "color", name: "Color", valueType: "TEXT", unit: null, filterable: true },
    {
      key: "storage_gb",
      name: "Almacenamiento",
      valueType: "INTEGER",
      unit: "GB",
      filterable: true,
    },
    { key: "ram_gb", name: "Memoria RAM", valueType: "INTEGER", unit: "GB", filterable: true },
    { key: "screen_inches", name: "Pantalla", valueType: "DECIMAL", unit: "in", filterable: true },
    { key: "weight_grams", name: "Peso", valueType: "INTEGER", unit: "g", filterable: true },
    { key: "connectivity", name: "Conectividad", valueType: "TEXT", unit: null, filterable: true },
    {
      key: "battery_capacity_mah",
      name: "Capacidad de batería",
      valueType: "INTEGER",
      unit: "mAh",
      filterable: true,
    },
    { key: "wireless", name: "Inalámbrico", valueType: "BOOLEAN", unit: null, filterable: true },
    {
      key: "warranty_url",
      name: "URL de garantía",
      valueType: "URL",
      unit: null,
      filterable: false,
    },
    {
      key: "technical_details",
      name: "Detalles técnicos",
      valueType: "JSON",
      unit: null,
      filterable: false,
    },
  ],
  taxGroups: [
    { code: "IVA_19", rateBps: 1900, uvtLimit: null },
    { code: "IVA_5", rateBps: 500, uvtLimit: null },
    { code: "EXENTO_0", rateBps: 0, uvtLimit: null },
    { code: "EXCLUIDO", rateBps: 0, uvtLimit: null },
  ],
} as const;

export type CatalogBlueprint = typeof catalogBlueprint;
