/**
 * WooEMulate Serializer
 * Serializes generic store orders into the WooCommerce REST API order schema (v1, v2, or v3).
 */

import { wcDatePair } from './dates.js'
import { currencySymbol, formatCurrency, getWcNumericId, mapToWcStatus, splitName } from './helpers.js'
import type {
  WooEmulateAddress,
  WooEmulateOrder,
  WooEmulateOrderNote,
  WooEmulateStoreConfig,
} from './types.js'

export interface WcSerializeOptions {
  /** REST namespace version that shapes the response. Defaults to v3. */
  version?: 'v1' | 'v2' | 'v3'
  /** Absolute namespace URL (for example `https://store.example/wp-json/wc/v3`) used for `_links`. */
  apiBase?: string
  /** Decimal places for money fields. Defaults to 2. */
  dp?: number
}

/** WooCommerce's paid statuses (`wc_get_is_paid_statuses`). */
const PAID_STATUSES = ['processing', 'completed']

export function metaDataArray(metadata?: Record<string, unknown>): Array<{ key: string; value: unknown }> {
  return Object.entries(metadata || {}).map(([key, value]) => ({ key, value }))
}

export function serializeAddress(
  address: Partial<WooEmulateAddress> | undefined,
  fallback: { email?: string; phone?: string } = {},
  { includeEmail = true, defaultCountry = '' }: { includeEmail?: boolean; defaultCountry?: string } = {}
): Record<string, string> {
  // Split a combined name only when no separate last name is provided.
  const name = address?.lastName
    ? { firstName: address.firstName || '', lastName: address.lastName }
    : address?.firstName
      ? splitName(address.firstName)
      : { firstName: '', lastName: '' }
  const result: Record<string, string> = {
    first_name: name.firstName,
    last_name: name.lastName,
    company: address?.company || '',
    address_1: address?.address1 || '',
    address_2: address?.address2 || '',
    city: address?.city || '',
    state: address?.state || '',
    postcode: address?.postalCode || '',
    country: address?.country || defaultCountry,
  }
  if (includeEmail) result.email = address?.email || fallback.email || ''
  result.phone = address?.phone || fallback.phone || ''
  return result
}

function sum(values: Array<number | undefined>): number {
  return values.reduce<number>((total, value) => total + (value || 0), 0)
}

export function serializeWcOrder(
  order: WooEmulateOrder,
  storeConfig: WooEmulateStoreConfig,
  options: WcSerializeOptions = {}
): Record<string, any> {
  const version = options.version ?? 'v3'
  const dp = options.dp ?? 2
  const money = (cents?: number | null) => formatCurrency(cents, dp)
  const timeZone = storeConfig.timezone || 'UTC'
  const numericId = getWcNumericId(order.wooCommerceId ?? order.id)
  const wcStatus = mapToWcStatus(order.status)
  const currency = order.currency || storeConfig.currency || 'USD'
  const contact = { email: order.customer?.email, phone: order.customer?.phone }

  // Package dimension & weight calculations
  let totalWeightLb = 0
  let maxLen = 0
  let maxWid = 0
  let maxHei = 0

  const lineItems = (order.items || []).map((item, idx) => {
    const itemWeight = item.weightLb || 0
    const quantity = item.quantity || 1
    totalWeightLb += itemWeight * quantity

    if (item.dimensionsIn) {
      if ((item.dimensionsIn.length || 0) > maxLen) maxLen = item.dimensionsIn.length || 0
      if ((item.dimensionsIn.width || 0) > maxWid) maxWid = item.dimensionsIn.width || 0
      if ((item.dimensionsIn.height || 0) > maxHei) maxHei = item.dimensionsIn.height || 0
    }

    const total = item.totalPriceCents ?? item.unitPriceCents * quantity
    const subtotal = item.subtotalCents ?? total
    const tax = item.taxCents ?? 0
    return {
      id: typeof item.id === 'number' ? item.id : idx + 1,
      name: item.name,
      product_id: item.productId ?? 0,
      variation_id: item.variationId ?? 0,
      quantity,
      tax_class: item.taxClass ?? '',
      subtotal: money(subtotal),
      subtotal_tax: money(item.subtotalTaxCents ?? tax),
      total: money(total),
      total_tax: money(tax),
      taxes: (item.taxes || []).map((rate) => ({
        id: rate.rateId,
        total: money(rate.totalCents),
        subtotal: money(rate.subtotalCents ?? rate.totalCents),
      })),
      meta_data: metaDataArray(item.metadata),
      sku: item.sku || '',
      price: quantity ? total / 100 / quantity : 0,
      image: { id: '', src: item.imageUrl || '' },
      parent_name: item.parentName ?? null,
      weight: itemWeight > 0 ? itemWeight.toFixed(2) : undefined,
    }
  })

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
  metaData.push(...metaDataArray(order.metadata))

  // Shipping lines: explicit lines win; otherwise one line is synthesized from shippingCents.
  const shippingLines = order.shippingLines
    ? order.shippingLines.map((line, idx) => ({
        id: line.id ?? idx + 1,
        method_title: line.methodTitle,
        method_id: line.methodId,
        instance_id: line.instanceId ?? '',
        total: money(line.totalCents),
        total_tax: money(line.taxCents ?? sum((line.taxes || []).map((rate) => rate.totalCents))),
        taxes: (line.taxes || []).map((rate) => ({ id: rate.rateId, total: money(rate.totalCents), subtotal: '' })),
        meta_data: metaDataArray(line.metadata),
      }))
    : [
        {
          id: 1,
          method_title: order.shippingCents === 0 ? 'Free Shipping' : 'Standard Shipping',
          method_id: order.shippingCents === 0 ? 'free_shipping' : 'flat_rate',
          instance_id: '0',
          total: money(order.shippingCents),
          total_tax: money(order.shippingTaxCents),
          taxes: [],
          meta_data: [],
        },
      ]

  const shippingCents = order.shippingCents ?? sum((order.shippingLines || []).map((line) => line.totalCents))
  const shippingTax =
    order.shippingTaxCents ?? sum((order.shippingLines || []).map((line) => line.taxCents))
  const taxLinesCartTax = order.taxLines ? sum(order.taxLines.map((line) => line.taxCents)) : undefined
  const cartTax =
    order.cartTaxCents ??
    (order.taxCents !== undefined ? order.taxCents - shippingTax : taxLinesCartTax ?? 0)
  const totalTax = order.taxCents ?? cartTax + shippingTax
  const discount = order.discountCents ?? sum((order.couponLines || []).map((line) => line.discountCents))
  const discountTax =
    order.discountTaxCents ?? sum((order.couponLines || []).map((line) => line.discountTaxCents))

  const created = wcDatePair(order.createdAt, timeZone)
  const modified = order.updatedAt ? wcDatePair(order.updatedAt, timeZone) : created
  const paid =
    order.paidAt !== undefined
      ? wcDatePair(order.paidAt, timeZone)
      : PAID_STATUSES.includes(wcStatus)
        ? created
        : wcDatePair(null)
  const completed =
    order.completedAt !== undefined
      ? wcDatePair(order.completedAt, timeZone)
      : wcStatus === 'completed'
        ? wcDatePair(order.tracking?.dateShipped, timeZone)
        : wcDatePair(null)

  const result: Record<string, any> = {
    id: numericId,
    parent_id: order.parentId ?? 0,
    number: order.orderNumber || String(order.id),
    order_key: order.orderKey ?? `wc_order_${order.id}`,
    created_via: order.createdVia ?? 'checkout',
    version: storeConfig.version || '8.5.0',
    status: wcStatus,
    currency,
    currency_symbol: currencySymbol(currency),
    date_created: created.local,
    date_created_gmt: created.gmt,
    date_modified: modified.local,
    date_modified_gmt: modified.gmt,
    discount_total: money(discount),
    discount_tax: money(discountTax),
    shipping_total: money(shippingCents),
    shipping_tax: money(shippingTax),
    cart_tax: money(cartTax),
    total: money(order.totalCents),
    total_tax: money(totalTax),
    prices_include_tax: order.pricesIncludeTax ?? false,
    customer_id: order.customerId ?? 0,
    customer_ip_address: order.customerIpAddress ?? '',
    customer_user_agent: order.customerUserAgent ?? '',
    customer_note: order.notes || '',
    // Orders keep the historical US default for a missing country.
    billing: serializeAddress(order.billingAddress || order.shippingAddress, contact, { defaultCountry: 'US' }),
    shipping: serializeAddress(order.shippingAddress, contact, { includeEmail: false, defaultCountry: 'US' }),
    payment_method: order.paymentMethod || 'standard',
    payment_method_title: order.paymentMethodTitle || 'Credit Card',
    transaction_id: order.transactionId || '',
    date_paid: paid.local,
    date_paid_gmt: paid.gmt,
    date_completed: completed.local,
    date_completed_gmt: completed.gmt,
    cart_hash: '',
    meta_data: metaData,
    line_items: lineItems,
    tax_lines: (order.taxLines || []).map((line, idx) => ({
      id: line.id ?? idx + 1,
      rate_code: line.rateCode,
      rate_id: line.rateId,
      label: line.label,
      compound: line.compound ?? false,
      tax_total: money(line.taxCents),
      shipping_tax_total: money(line.shippingTaxCents),
      rate_percent: line.ratePercent ?? 0,
      meta_data: [],
    })),
    shipping_lines: shippingLines,
    fee_lines: (order.feeLines || []).map((line, idx) => ({
      id: line.id ?? idx + 1,
      name: line.name,
      tax_class: line.taxClass ?? '',
      tax_status: line.taxStatus ?? 'taxable',
      amount: money(line.totalCents),
      total: money(line.totalCents),
      total_tax: money(line.taxCents),
      taxes: [],
      meta_data: [],
    })),
    coupon_lines: (order.couponLines || []).map((line, idx) => ({
      id: line.id ?? idx + 1,
      code: line.code,
      discount: money(line.discountCents),
      discount_tax: money(line.discountTaxCents),
      meta_data: [],
    })),
    refunds: (order.refunds || []).map((refund) => ({
      id: refund.id,
      reason: refund.reason ?? '',
      total: `-${money(refund.totalCents)}`,
    })),
    payment_url: order.paymentUrl ?? '',
    is_editable: ['pending', 'on-hold'].includes(wcStatus),
    needs_payment: ['pending', 'failed'].includes(wcStatus) && order.totalCents > 0,
    needs_processing: lineItems.length > 0,
  }

  if (options.apiBase) {
    result._links = {
      self: [{ href: `${options.apiBase}/orders/${numericId}` }],
      collection: [{ href: `${options.apiBase}/orders` }],
      ...(order.customerId ? { customer: [{ href: `${options.apiBase}/customers/${order.customerId}` }] } : {}),
    }
  }

  return shapeForVersion(result, version)
}

/** Removes v3-only fields for v2, and applies the v1 schema (no GMT dates, item `meta`). */
function shapeForVersion(order: Record<string, any>, version: 'v1' | 'v2' | 'v3'): Record<string, any> {
  if (version === 'v3') return order
  for (const item of order.line_items) {
    delete item.image
    delete item.parent_name
  }
  if (version === 'v2') return order

  order.date_created = order.date_created_gmt
  order.date_modified = order.date_modified_gmt
  for (const key of ['date_created_gmt', 'date_modified_gmt', 'date_paid_gmt', 'date_completed_gmt']) {
    delete order[key]
  }
  for (const key of ['meta_data', 'currency_symbol', 'payment_url', 'is_editable', 'needs_payment', 'needs_processing']) {
    delete order[key]
  }
  order.line_items = order.line_items.map((item: Record<string, any>) => {
    const { meta_data, ...rest } = item
    return {
      ...rest,
      price: typeof rest.price === 'number' ? rest.price.toFixed(2) : rest.price,
      meta: (meta_data as Array<{ key: string; value: unknown }>).map((entry) => ({
        key: entry.key,
        label: entry.key,
        value: entry.value,
      })),
    }
  })
  return order
}

export function serializeWcOrderNote(
  note: WooEmulateOrderNote,
  storeConfig: WooEmulateStoreConfig,
  options: WcSerializeOptions & { orderId: number }
): Record<string, any> {
  const version = options.version ?? 'v3'
  const created = wcDatePair(note.createdAt, storeConfig.timezone || 'UTC')
  const result: Record<string, any> = { id: note.id }
  if (version === 'v3') result.author = note.author || 'system'
  if (version === 'v1') {
    result.date_created = created.gmt
  } else {
    result.date_created = created.local
    result.date_created_gmt = created.gmt
  }
  result.note = note.note
  result.customer_note = Boolean(note.customerNote)
  if (options.apiBase) {
    const orderPath = `${options.apiBase}/orders/${options.orderId}`
    result._links = {
      self: [{ href: `${orderPath}/notes/${note.id}` }],
      collection: [{ href: `${orderPath}/notes` }],
      up: [{ href: orderPath }],
    }
  }
  return result
}
