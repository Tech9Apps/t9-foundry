'use strict';

const { findProduct } = require('./catalog');
const { priceCart, normalizeCode, isKnownCoupon } = require('./pricing');

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function createCartStore() {
  const carts = new Map(); // email -> { items: Map(sku -> qty), coupons: [] }
  const orders = [];

  const cartFor = (email) => {
    if (!carts.has(email)) carts.set(email, { items: new Map(), coupons: [] });
    return carts.get(email);
  };

  function view(email) {
    const cart = cartFor(email);
    const items = [...cart.items].map(([sku, qty]) => {
      const product = findProduct(sku);
      return { sku, name: product.name, price: product.price, qty, lineTotal: product.price * qty };
    });
    return { items, coupons: [...cart.coupons], totals: priceCart(items, cart.coupons) };
  }

  function addItem(email, sku, qty) {
    const product = findProduct(sku);
    if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', `Product ${sku} not found`);
    if (!Number.isInteger(qty) || qty < 1 || qty > 10) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'qty must be a whole number from 1 to 10');
    }
    const cart = cartFor(email);
    cart.items.set(sku, (cart.items.get(sku) || 0) + qty);
    return view(email);
  }

  function addCoupon(email, rawCode) {
    const code = normalizeCode(rawCode);
    if (!isKnownCoupon(code)) throw new ApiError(400, 'INVALID_COUPON', 'Invalid discount code');
    const cart = cartFor(email);
    if (cart.coupons.length > 0 && !cart.coupons.includes(code)) {
      throw new ApiError(400, 'COUPON_LIMIT', 'Only one discount code per order');
    }
    cart.coupons.push(code);
    return view(email);
  }

  function checkout(email) {
    const current = view(email);
    if (current.items.length === 0) throw new ApiError(400, 'EMPTY_CART', 'Your cart is empty');
    const order = { id: `ORD-${1001 + orders.length}`, ...current };
    orders.push(order);
    carts.delete(email);
    return order;
  }

  return { view, addItem, addCoupon, checkout };
}

module.exports = { createCartStore, ApiError };
