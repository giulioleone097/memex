const products = [
  {
    sku: "CAM-100",
    name: "Northstar Field Camera",
    category: "imaging",
    priceCents: 24900,
    active: true,
  },
  {
    sku: "TRI-200",
    name: "Carbon Survey Tripod",
    category: "mounts",
    priceCents: 8900,
    active: true,
  },
  {
    sku: "GPS-OLD",
    name: "Legacy GPS Receiver",
    category: "navigation",
    priceCents: 15900,
    active: false,
  },
];

export function listActiveProducts() {
  return products.filter(({ active }) => active).map((product) => ({ ...product }));
}

export function findProductBySku(input) {
  const sku = input.trim().toUpperCase();
  return products.find((product) => product.sku === sku);
}

export function summarizeCatalog() {
  const active = listActiveProducts();
  return {
    activeCount: active.length,
    inventoryValueCents: active.reduce((total, product) => total + product.priceCents, 0),
  };
}
