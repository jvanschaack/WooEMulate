/**
 * WooEMulate Serializer
 * Serializes generic store orders into strict WooCommerce REST API v3 schema.
 */

import { wcDatePair } from './dates.js'
import { formatCurrency, getWcNumericId, mapToWcStatus, splitName } from './helpers.js'
import type { WooEmulateOrder, WooEmulateStoreConfig } from './types.js'

export interface WcSerializeOptions {
  /** REST namespace version that shapes the response. Defaults to v3. */
  version?: 'v1' | 'v2' | 'v3'
  /** Absolute namespace URL (for example `https://store.example/wp-json/wc/v3`) used for `_links`. */
  apiBase?: string
  /** Decimal places for money fields. Defaults to 2. */
  dp?: number
}

export function serializeWcOrder(
  order: WooEmulateOrder,
  storeConfig: WooEmulateStoreConfig,
  options: WcSerializeOptions = {}
): Record<string, any> {
  const dp = options.dp ?? 2
  const money = (cents?: number | null) => formatCurrency(cents, dp)
  const timeZone = storeConfig.timezone || 'UTC'
  const numericId = getWcNumericId(order.wooCommerceId ?? order.id)
  const wcStatus = mapToWcStatus(order.status)
  const currency = order.currency || storeConfig.currency || 'USD'

  // Shipping name parsing
  const shippingName = splitName(
    order.shippingAddress.firstName +
      (order.shippingAddress.lastName ? ` ${order.shippingAddress.lastName}` : '')
  )

  // Billing name parsing
  const billingAddr = order.billingAddress || order.shippingAddress
  const billingName = splitName(
    billingAddr.firstName + (billingAddr.lastName ? ` ${billingAddr.lastName}` : '')
  )

  // Package dimension & weight calculations
  let totalWeightLb = 0
  let maxLen = 0
  let maxWid = 0
  let maxHei = 0

  const lineItems = (order.items || []).map((item, idx) => {
    const itemWeight = item.weightLb || 0
    const itemQuantity = item.quantity || 1
    totalWeightLb += itemWeight * itemQuantity

    if (item.dimensionsIn) {
      if ((item.dimensionsIn.length || 0) > maxLen) maxLen = item.dimensionsIn.length || 0
      if ((item.dimensionsIn.width || 0) > maxWid) maxWid = item.dimensionsIn.width || 0
      if ((item.dimensionsIn.height || 0) > maxHei) maxHei = item.dimensionsIn.height || 0
    }

    const unitPrice = item.unitPriceCents / 100
    const totalPrice = item.totalPriceCents
      ? item.totalPriceCents / 100
      : unitPrice * itemQuantity

    return {
      id: typeof item.id === 'number' ? item.id : idx + 1,
      name: item.name,
      product_id: typeof item.id === 'number' ? item.id : idx + 100,
      variation_id: 0,
      quantity: itemQuantity,
      tax_class: '',
      subtotal: totalPrice.toFixed(2),
      subtotal_tax: '0.00',
      total: totalPrice.toFixed(2),
      total_tax: '0.00',
      taxes: [],
      meta_data: [],
      sku: item.sku || '',
      price: unitPrice,
      weight: itemWeight > 0 ? itemWeight.toFixed(2) : undefined,
    }
  })

  // Format addresses
  const shipping = {
    first_name: shippingName.firstName,
    last_name: shippingName.lastName,
    company: order.shippingAddress.company || '',
    address_1: order.shippingAddress.address1 || '',
    address_2: order.shippingAddress.address2 || '',
    city: order.shippingAddress.city || '',
    state: order.shippingAddress.state || '',
    postcode: order.shippingAddress.postalCode || '',
    country: order.shippingAddress.country || 'US',
    email: order.shippingAddress.email || order.customer?.email || '',
    phone: order.shippingAddress.phone || order.customer?.phone || '',
  }

  const billing = {
    first_name: billingName.firstName,
    last_name: billingName.lastName,
    company: billingAddr.company || '',
    address_1: billingAddr.address1 || '',
    address_2: billingAddr.address2 || '',
    city: billingAddr.city || '',
    state: billingAddr.state || '',
    postcode: billingAddr.postalCode || '',
    country: billingAddr.country || 'US',
    email: billingAddr.email || order.customer?.email || '',
    phone: billingAddr.phone || order.customer?.phone || '',
  }

  // Meta data (shipping dimensions, weights, tracking, custom attributes)
  const metaData: Array<{ id?: number; key: string; value: any }> = []

  if (totalWeightLb > 0) {
    metaData.push({ key: '_shipping_weight', value: totalWeightLb.toFixed(2) })
  }
  if (maxLen > 0) metaData.push({ key: '_package_length', value: maxLen.toFixed(1) })
  if (maxWid > 0) metaData.push({ key: '_package_width', value: maxWid.toFixed(1) })
  if (maxHei > 0) metaData.push({ key: '_package_height', value: maxHei.toFixed(1) })

  metaData.push({ key: '_original_order_id', value: String(order.id) })

  if (order.tracking?.trackingNumber) {
    metaData.push(
      { key: '_tracking_number', value: order.tracking.trackingNumber },
      { key: '_tracking_provider', value: order.tracking.carrier || 'USPS' },
      {
        key: '_date_shipped',
        value: order.tracking.dateShipped ? String(order.tracking.dateShipped) : '',
      }
    )
  }

  // Append user metadata
  if (order.metadata) {
    for (const [key, value] of Object.entries(order.metadata)) {
      metaData.push({ key, value })
    }
  }

  const created = wcDatePair(order.createdAt, timeZone)
  const modified = order.updatedAt ? wcDatePair(order.updatedAt, timeZone) : created
  const completed = wcDatePair(order.tracking?.dateShipped, timeZone)

  const shippingCost = money(order.shippingCents)
  const totalCost = money(order.totalCents)
  const taxCost = money(order.taxCents)
  const discountCost = money(order.discountCents)

  return {
    id: numericId,
    parent_id: 0,
    number: order.orderNumber || String(order.id),
    order_key: `wc_order_${order.id}`,
    created_via: 'checkout',
    version: storeConfig.version || '8.5.0',
    status: wcStatus,
    currency,
    date_created: created.local,
    date_created_gmt: created.gmt,
    date_modified: modified.local,
    date_modified_gmt: modified.gmt,
    discount_total: discountCost,
    discount_tax: money(0),
    shipping_total: shippingCost,
    shipping_tax: money(0),
    cart_tax: money(0),
    total: totalCost,
    total_tax: taxCost,
    prices_include_tax: false,
    customer_id: 0,
    customer_ip_address: '',
    customer_user_agent: '',
    customer_note: order.notes || '',
    billing,
    shipping,
    payment_method: order.paymentMethod || 'standard',
    payment_method_title: order.paymentMethodTitle || 'Credit Card',
    transaction_id: order.transactionId || '',
    date_paid: created.local,
    date_paid_gmt: created.gmt,
    date_completed: completed.local,
    date_completed_gmt: completed.gmt,
    cart_hash: '',
    meta_data: metaData,
    line_items: lineItems,
    tax_lines: [],
    shipping_lines: [
      {
        id: 1,
        method_title: order.shippingCents === 0 ? 'Free Shipping' : 'Standard Shipping',
        method_id: 'flat_rate',
        instance_id: '0',
        total: shippingCost,
        total_tax: '0.00',
        taxes: [],
        meta_data: [],
      },
    ],
    fee_lines: [],
    coupon_lines: [],
    refunds: [],
    is_editable: false,
    needs_processing: wcStatus === 'processing',
    needs_payment: false,
  }
}
