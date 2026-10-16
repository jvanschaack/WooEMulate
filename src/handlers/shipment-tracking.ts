/**
 * WooEMulate Shipment Tracking Handler
 * Implements a subset of the WooCommerce Shipment Tracking extension API. The same routes are
 * served under `wc/v1-3` and the Advanced Shipment Tracking namespaces
 * (`wc-shipment-tracking/v3`, `wc-ast/v3`).
 */

import { wcErrorResponse } from '../auth.js'
import { detectCarrier, getTrackingUrl } from '../helpers.js'
import { errorMessage, jsonResponse, routeUrl, type RouteContext } from '../http.js'
import { findOrderByApiId } from '../order-lookup.js'
import type { WooEmulateOrder } from '../types.js'

const PROVIDERS = {
  'United States': {
    USPS: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=%1$s',
    UPS: 'https://www.ups.com/track?tracknum=%1$s',
    FedEx: 'https://www.fedex.com/fedextrack/?trknbr=%1$s',
    DHL: 'https://www.dhl.com/en/express/tracking.html?AWB=%1$s',
  },
}

function trackingRecord(ctx: RouteContext, order: WooEmulateOrder) {
  const tracking = order.tracking
  if (!tracking?.trackingNumber) return null
  const carrier = tracking.carrier || detectCarrier(tracking.trackingNumber) || 'USPS'
  const trackingId = tracking.id || '1'
  return {
    tracking_id: trackingId,
    tracking_provider: carrier,
    custom_tracking_provider: carrier,
    tracking_number: tracking.trackingNumber,
    date_shipped: tracking.dateShipped
      ? String(tracking.dateShipped instanceof Date ? tracking.dateShipped.toISOString() : tracking.dateShipped).slice(0, 10)
      : new Date().toISOString().slice(0, 10),
    custom_tracking_link: tracking.trackingUrl || getTrackingUrl(tracking.trackingNumber, carrier),
    _links: links(ctx, trackingId),
  }
}

function links(ctx: RouteContext, trackingId: string | number) {
  const orderPath = `/orders/${ctx.params.order_id}`
  return {
    self: [{ href: routeUrl(ctx, `${orderPath}/shipment-trackings/${trackingId}`) }],
    up: [{ href: routeUrl(ctx, orderPath) }],
  }
}

async function loadOrder(ctx: RouteContext): Promise<WooEmulateOrder | Response> {
  try {
    const order = await findOrderByApiId(ctx.config, ctx.params.order_id)
    return order ?? wcErrorResponse('woocommerce_rest_order_invalid_id', 'Invalid order ID.', 404)
  } catch {
    return wcErrorResponse('woocommerce_rest_order_error', 'Failed to retrieve order.', 500)
  }
}

export async function listShipmentTrackings(ctx: RouteContext): Promise<Response> {
  const order = await loadOrder(ctx)
  if (order instanceof Response) return order
  const record = trackingRecord(ctx, order)
  return jsonResponse(record ? [record] : [])
}

export async function getShipmentTracking(ctx: RouteContext): Promise<Response> {
  const order = await loadOrder(ctx)
  if (order instanceof Response) return order
  const record = trackingRecord(ctx, order)
  if (!record || String(record.tracking_id) !== ctx.params.id) {
    return wcErrorResponse('woocommerce_rest_invalid_tracking_id', 'Invalid tracking ID.', 404)
  }
  return jsonResponse(record)
}

export async function listShipmentTrackingProviders(): Promise<Response> {
  return jsonResponse(PROVIDERS)
}

export async function createShipmentTracking(ctx: RouteContext): Promise<Response> {
  const order = await loadOrder(ctx)
  if (order instanceof Response) return order
  const { config } = ctx
  try {
    const body = await ctx.input()
    const trackingNumber = String(body.tracking_number || body.custom_tracking_number || '').trim()
    let carrier = String(body.tracking_provider || body.custom_tracking_provider || body.carrier || '').trim()
    const dateShipped = String(body.date_shipped || new Date().toISOString().slice(0, 10)).trim()

    if (!trackingNumber) {
      return wcErrorResponse('woocommerce_rest_missing_field', 'Tracking number is required.', 400)
    }

    if (!carrier) {
      carrier = detectCarrier(trackingNumber) || 'Standard Shipping'
    }

    const trackingLink = body.custom_tracking_link || getTrackingUrl(trackingNumber, carrier)

    let trackingId: string | number = 1
    if (config.adapter.onShipmentTrackingCreated) {
      const result = await config.adapter.onShipmentTrackingCreated(order.id, {
        trackingNumber,
        carrier,
        dateShipped,
        trackingUrl: trackingLink,
      })
      if (result && result.id) trackingId = result.id
    }

    // Mark order completed if updateOrderStatus is provided
    if (config.adapter.updateOrderStatus) {
      await config.adapter.updateOrderStatus(order.id, 'completed')
    }

    return jsonResponse(
      {
        tracking_id: trackingId,
        tracking_provider: carrier,
        custom_tracking_provider: carrier,
        tracking_number: trackingNumber,
        date_shipped: dateShipped,
        custom_tracking_link: trackingLink,
        _links: links(ctx, trackingId),
      },
      201
    )
  } catch (err) {
    return wcErrorResponse(
      'woocommerce_rest_tracking_create_error',
      errorMessage(err, 'Failed to save tracking record'),
      500
    )
  }
}
