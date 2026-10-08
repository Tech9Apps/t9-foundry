'use strict';

// Prices are integer cents — money is never a float in this app.
const PRODUCTS = [
  { sku: 'espresso-beans', name: 'Espresso Beans 1kg', price: 2400 },
  { sku: 'cold-brew-kit', name: 'Cold Brew Kit', price: 3950 },
  { sku: 'pour-over-kit', name: 'Pour-Over Kit', price: 2500 },
  { sku: 'ceramic-mug', name: 'Ceramic Mug', price: 1200 },
  { sku: 'sample-sachet', name: 'Sample Sachet', price: 300 },
  { sku: 'grinder', name: 'Burr Grinder', price: 8900 },
];

const bySku = new Map(PRODUCTS.map((p) => [p.sku, p]));

module.exports = {
  PRODUCTS,
  findProduct: (sku) => bySku.get(sku),
};
