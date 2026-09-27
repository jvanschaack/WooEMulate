/**
 * WooEMulate Serializer
 * Serializes generic store orders into strict WooCommerce REST API v3 schema.
 */

import { formatCurrency, getWcNumericId, mapToWcStatus, splitName } from './helpers.js'
import type { WooEmulateOrder, WooEmulateStoreConfig } from './types.js'

export function serializeWcOrder(
  order: WooEmulateOrder,
  storeConfig: WooEmulateStoreConfig
): Record<string, any> {
  const numericId = getWcNumericId(order.orderNumber || order.id)
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

  const createdIso =
    order.createdAt instanceof Date ? order.createdAt.toISOString() : String(order.createdAt)
  const updatedIso = order.updatedAt
    ? order.updatedAt instanceof Date
      ? order.updatedAt.toISOString()
      : String(order.updatedAt)
    : createdIso

  const shippingCost = formatCurrency(order.shippingCents)
  const totalCost = formatCurrency(order.totalCents)
  const taxCost = formatCurrency(order.taxCents)
  const discountCost = formatCurrency(order.discountCents)

  return {
    id: numericId,
    parent_id: 0,
    number: order.orderNumber || String(order.id),
    order_key: `wc_order_${order.id}`,
    created_via: 'checkout',
    version: storeConfig.version || '8.5.0',
    status: wcStatus,
    currency,
    date_created: createdIso,
    date_created_gmt: createdIso,
    date_modified: updatedIso,
    date_modified_gmt: updatedIso,
    discount_total: discountCost,
    discount_tax: '0.00',
    shipping_total: shippingCost,
    shipping_tax: '0.00',
    cart_tax: '0.00',
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
    date_paid: createdIso,
    date_paid_gmt: createdIso,
    date_completed: order.tracking?.dateShipped ? String(order.tracking.dateShipped) : null,
    date_completed_gmt: order.tracking?.dateShipped ? String(order.tracking.dateShipped) : null,
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
