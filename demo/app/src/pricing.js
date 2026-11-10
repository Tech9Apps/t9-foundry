'use strict';

const COUPONS = {
  BREW10: { type: 'percent', value: 10 },
  WELCOME5: { type: 'fixed', value: 500 },
};

const TAX_RATE_PERCENT = 8;
const SHIPPING_FLAT = 500;
const FREE_SHIPPING_MIN = 5000;

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

function isKnownCoupon(code) {
  return Object.prototype.hasOwnProperty.call(COUPONS, normalizeCode(code));
}

// lines: [{ price, qty }]   couponCodes: normalized codes applied to the cart
function priceCart(lines, couponCodes) {
  const subtotal = lines.reduce((sum, line) => sum + line.price * line.qty, 0);

  let discount = 0;
  for (const code of couponCodes) {
    const coupon = COUPONS[code];
    if (!coupon) continue;
    discount += coupon.type === 'percent' ? Math.round((subtotal * coupon.value) / 100) : coupon.value;
  }
  discount = Math.min(discount, subtotal);

  const discounted = subtotal - discount;
  const shipping = lines.length === 0 ? 0 : subtotal >= FREE_SHIPPING_MIN ? 0 : SHIPPING_FLAT;
  const tax = Math.round((discounted * TAX_RATE_PERCENT) / 100);

  return { subtotal, discount, discounted, shipping, tax, total: discounted + shipping + tax };
}

module.exports = { priceCart, normalizeCode, isKnownCoupon, TAX_RATE_PERCENT, SHIPPING_FLAT, FREE_SHIPPING_MIN };
