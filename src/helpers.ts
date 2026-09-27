/**
 * WooEMulate Helpers
 * Utility functions for numeric ID hashing, name splitting, carrier detection, and status mapping.
 */

import type { WooEmulateOrderStatus } from './types.js'

/**
 * Validates a positive 31-bit API ID without hashing or discarding characters.
 * Persist a unique wooCommerceId for orders with arbitrary string IDs.
 */
export function getWcNumericId(idOrNumber: string | number): number {
  const numericId = typeof idOrNumber === 'number'
    ? idOrNumber
    : /^[1-9]\d*$/.test(idOrNumber) ? Number(idOrNumber) : NaN
  if (!Number.isInteger(numericId) || numericId < 1 || numericId > 2_147_483_647) {
    throw new Error('Order IDs must be positive 31-bit integers. Persist a unique wooCommerceId and implement getOrderByWooCommerceId for string IDs.')
  }
  return numericId
}

/**
 * Splits a full name string into firstName and lastName components.
 */
export function splitName(fullName?: string | null): { firstName: string; lastName: string } {
  if (!fullName || !fullName.trim()) {
    return { firstName: 'Customer', lastName: '' }
  }
  const parts = fullName.trim().split(/\s+/)
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: '' }
  }
  const firstName = parts[0]
  const lastName = parts.slice(1).join(' ')
  return { firstName, lastName }
}

/**
 * Normalizes an arbitrary status string to the WooCommerce status taxonomy.
 */
export function mapToWcStatus(status?: string | null): WooEmulateOrderStatus {
  if (!status) return 'processing'
  const s = status.toLowerCase().trim()
  if (s === 'processing' || s === 'paid') return 'processing'
  if (s === 'completed' || s === 'fulfilled' || s === 'shipped') return 'completed'
  if (s === 'cancelled' || s === 'canceled') return 'cancelled'
  if (s === 'refunded') return 'refunded'
  if (s === 'on-hold' || s === 'on_hold') return 'on-hold'
  if (s === 'pending') return 'pending'
  if (s === 'failed') return 'failed'
  return 'processing'
}

/**
 * Maps WooCommerce status string back to simplified status.
 */
export function mapFromWcStatus(wcStatus: string): WooEmulateOrderStatus {
  const s = wcStatus.toLowerCase().trim()
  if (s === 'pending') return 'pending'
  if (s === 'completed') return 'completed'
  if (s === 'processing') return 'processing'
  if (s === 'cancelled') return 'cancelled'
  if (s === 'refunded') return 'refunded'
  if (s === 'on-hold' || s === 'on_hold') return 'on-hold'
  if (s === 'failed') return 'failed'
  return 'processing'
}

/**
 * Detects common shipping carrier from a tracking number string.
 */
export function detectCarrier(trackingNumber: string): string {
  const clean = trackingNumber.replace(/[\s-]/g, '').toUpperCase()
  if (/^1Z[0-9A-Z]{16}$/.test(clean)) return 'UPS'
  if (/^(94|93|92|95)[0-9]{20}$/.test(clean) || /^[0-9]{20,22}$/.test(clean)) return 'USPS'
  if (/^[0-9]{12}$/.test(clean) || /^[0-9]{15}$/.test(clean)) return 'FedEx'
  if (/^[0-9]{10}$/.test(clean)) return 'DHL'
  return 'USPS'
}

/**
 * Generates tracking URL for major carriers.
 */
export function getTrackingUrl(trackingNumber: string, carrier?: string): string {
  const c = (carrier || detectCarrier(trackingNumber)).toUpperCase()
  const clean = encodeURIComponent(trackingNumber.trim())
  if (c.includes('UPS')) return `https://www.ups.com/track?tracknum=${clean}`
  if (c.includes('FEDEX')) return `https://www.fedex.com/fedextrack/?trknbr=${clean}`
  if (c.includes('DHL')) return `https://www.dhl.com/en/express/tracking.html?AWB=${clean}`
  return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${clean}`
}

/**
 * Formats cents into two-decimal string format.
 */
export function formatCurrency(cents?: number | null): string {
  if (typeof cents !== 'number' || isNaN(cents)) return '0.00'
  return (cents / 100).toFixed(2)
}
