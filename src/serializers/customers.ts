/**
 * WooEMulate customer, coupon, and refund serializers.
 */

import { wcDatePair } from '../dates.js'
import { formatCurrency, getWcNumericId } from '../helpers.js'
import { metaDataArray, serializeAddress } from '../serializer.js'
import type { WooEmulateCoupon, WooEmulateCustomer, WooEmulateRefund, WooEmulateStoreConfig } from '../types.js'
import type { CatalogSerializeOptions } from './products.js'

export function serializeWcCustomer(
  customer: WooEmulateCustomer,
  store: WooEmulateStoreConfig,
  options: CatalogSerializeOptions = {}
): Record<string, any> {
  const id = getWcNumericId(customer.wooCommerceId ?? customer.id)
  const timeZone = store.timezone || 'UTC'
  const created = wcDatePair(customer.createdAt, timeZone)
  const modified = customer.updatedAt ? wcDatePair(customer.updatedAt, timeZone) : created
  const result: Record<string, any> = {
    id,
    date_created: created.local,
    date_created_gmt: created.gmt,
    date_modified: modified.local,
    date_modified_gmt: modified.gmt,
    email: customer.email,
    first_name: customer.firstName ?? '',
    last_name: customer.lastName ?? '',
    role: customer.role ?? 'customer',
    username: customer.username ?? '',
    billing: serializeAddress(customer.billing),
    shipping: serializeAddress(customer.shipping, {}, { includeEmail: false }),
    is_paying_customer: customer.isPayingCustomer ?? false,
    avatar_url: customer.avatarUrl ?? '',
    meta_data: metaDataArray(customer.metadata),
  }
  if (options.version && options.version !== 'v3') {
    result.orders_count = customer.ordersCount ?? 0
    result.total_spent = formatCurrency(customer.totalSpentCents)
  }
  if (options.apiBase) {
    result._links = {
      self: [{ href: `${options.apiBase}/customers/${id}` }],
      collection: [{ href: `${options.apiBase}/customers` }],
    }
  }
  return result
}

export function serializeWcCoupon(
  coupon: WooEmulateCoupon,
  store: WooEmulateStoreConfig,
  options: CatalogSerializeOptions = {}
): Record<string, any> {
  const id = getWcNumericId(coupon.wooCommerceId ?? coupon.id)
  const timeZone = store.timezone || 'UTC'
  const created = wcDatePair(coupon.createdAt, timeZone)
  const modified = coupon.updatedAt ? wcDatePair(coupon.updatedAt, timeZone) : created
  const expires = wcDatePair(coupon.expiresAt, timeZone)
  const amount =
    coupon.discountType === 'percent' ? (coupon.percentOff ?? 0).toFixed(2) : formatCurrency(coupon.amountCents)
  const result: Record<string, any> = {
    id,
    code: coupon.code.toLowerCase(),
    amount,
    status: coupon.status ?? 'publish',
    date_created: created.local,
    date_created_gmt: created.gmt,
    date_modified: modified.local,
    date_modified_gmt: modified.gmt,
    discount_type: coupon.discountType,
    description: coupon.description ?? '',
    date_expires: expires.local,
    date_expires_gmt: expires.gmt,
    usage_count: coupon.usageCount ?? 0,
    individual_use: coupon.individualUse ?? false,
    product_ids: coupon.productIds ?? [],
    excluded_product_ids: coupon.excludedProductIds ?? [],
    usage_limit: coupon.usageLimit ?? null,
    usage_limit_per_user: coupon.usageLimitPerUser ?? null,
    limit_usage_to_x_items: coupon.limitUsageToXItems ?? null,
    free_shipping: coupon.freeShipping ?? false,
    product_categories: coupon.productCategories ?? [],
    excluded_product_categories: coupon.excludedProductCategories ?? [],
    exclude_sale_items: coupon.excludeSaleItems ?? false,
    minimum_amount: formatCurrency(coupon.minimumAmountCents),
    maximum_amount: formatCurrency(coupon.maximumAmountCents),
    email_restrictions: coupon.emailRestrictions ?? [],
    used_by: coupon.usedBy ?? [],
    meta_data: metaDataArray(coupon.metadata),
  }
  if (options.apiBase) {
    result._links = {
      self: [{ href: `${options.apiBase}/coupons/${id}` }],
      collection: [{ href: `${options.apiBase}/coupons` }],
    }
  }
  return result
}

export function serializeWcRefund(
  refund: WooEmulateRefund,
  store: WooEmulateStoreConfig,
  options: CatalogSerializeOptions & { orderId: number; dp?: number }
): Record<string, any> {
  const dp = options.dp ?? 2
  const money = (cents?: number) => formatCurrency(cents, dp)
  const negative = (cents?: number) => (cents ? `-${money(cents)}` : money(0))
  const created = wcDatePair(refund.createdAt, store.timezone || 'UTC')
  const result: Record<string, any> = {
    id: refund.id,
    date_created: created.local,
    date_created_gmt: created.gmt,
    amount: money(refund.amountCents),
    reason: refund.reason ?? '',
    refunded_by: refund.refundedBy ?? 0,
    refunded_payment: refund.refundedPayment ?? false,
    meta_data: metaDataArray(refund.metadata),
    line_items: (refund.lineItems ?? []).map((item, index) => ({
      id: item.id ?? index + 1,
      name: item.name,
      product_id: item.productId ?? 0,
      variation_id: item.variationId ?? 0,
      quantity: -Math.abs(item.quantity),
      tax_class: '',
      subtotal: negative(item.totalCents),
      subtotal_tax: negative(item.taxCents),
      total: negative(item.totalCents),
      total_tax: negative(item.taxCents),
      taxes: [],
      meta_data: item.refundedItemId ? [{ key: '_refunded_item_id', value: String(item.refundedItemId) }] : [],
      sku: item.sku ?? '',
      price: item.quantity ? -Math.abs(item.totalCents / 100 / item.quantity) : 0,
    })),
    shipping_lines: [],
    tax_lines: [],
    fee_lines: [],
  }
  if (options.apiBase) {
    const orderPath = `${options.apiBase}/orders/${options.orderId}`
    result._links = {
      self: [{ href: `${orderPath}/refunds/${refund.id}` }],
      collection: [{ href: `${orderPath}/refunds` }],
      up: [{ href: orderPath }],
    }
  }
  return result
}
