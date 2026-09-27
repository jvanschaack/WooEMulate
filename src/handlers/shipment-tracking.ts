/**
 * WooEMulate Shipment Tracking Handler
 * Emulates the WooCommerce Shipment Tracking official extension endpoint used by Pirate Ship & ShipStation.
 */

import { authenticateRequest, wcErrorResponse } from '../auth.js'
import { detectCarrier, getTrackingUrl } from '../helpers.js'
import type { WooEmulateConfig } from '../types.js'

export async function handleShipmentTracking(
  config: WooEmulateConfig,
  request: Request,
  orderIdParam: string
): Promise<Response> {
  const auth = await authenticateRequest(request, config)
  if (!auth.authenticated) {
    return wcErrorResponse(
      'woocommerce_rest_cannot_view',
      auth.error || 'Authentication required',
      auth.status || 401
    )
  }

  const order = await config.adapter.getOrder(orderIdParam)
  if (!order) {
    return wcErrorResponse('woocommerce_rest_order_invalid_id', 'Invalid order ID.', 404)
  }

  const url = new URL(request.url)

  // 1. GET shipment-trackings
  if (request.method === 'GET') {
    const trackings: any[] = []
    if (order.tracking && order.tracking.trackingNumber) {
      const carrier =
        order.tracking.carrier || detectCarrier(order.tracking.trackingNumber) || 'USPS'
      const trackingLink =
        order.tracking.trackingUrl || getTrackingUrl(order.tracking.trackingNumber, carrier)
      const trackingId = order.tracking.id || '1'
      const dateShippedStr = order.tracking.dateShipped
        ? String(order.tracking.dateShipped).slice(0, 10)
        : new Date().toISOString().slice(0, 10)

      trackings.push({
        tracking_id: trackingId,
        tracking_provider: carrier,
        custom_tracking_provider: carrier,
        tracking_number: order.tracking.trackingNumber,
        date_shipped: dateShippedStr,
        custom_tracking_link: trackingLink,
        _links: {
          self: [
            {
              href: `${url.origin}/wp-json/wc/v3/orders/${orderIdParam}/shipment-trackings/${trackingId}`,
            },
          ],
          up: [{ href: `${url.origin}/wp-json/wc/v3/orders/${orderIdParam}` }],
        },
      })
    }

    return new Response(JSON.stringify(trackings), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      },
    })
  }

  // 2. POST shipment-trackings (Created by Pirate Ship / ShipStation)
  if (request.method === 'POST') {
    try {
      const body = await request.json().catch(() => ({}))
      const trackingNumber = (body.tracking_number || body.custom_tracking_number || '').trim()
      let carrier = (
        body.tracking_provider ||
        body.custom_tracking_provider ||
        body.carrier ||
        ''
      ).trim()
      const dateShipped = (body.date_shipped || new Date().toISOString().slice(0, 10)).trim()

      if (!trackingNumber) {
        return wcErrorResponse(
          'woocommerce_rest_missing_field',
          'Tracking number is required.',
          400
        )
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

      const trackingRecord = {
        tracking_id: trackingId,
        tracking_provider: carrier,
        custom_tracking_provider: carrier,
        tracking_number: trackingNumber,
        date_shipped: dateShipped,
        custom_tracking_link: trackingLink,
        _links: {
          self: [
            {
              href: `${url.origin}/wp-json/wc/v3/orders/${orderIdParam}/shipment-trackings/${trackingId}`,
            },
          ],
          up: [{ href: `${url.origin}/wp-json/wc/v3/orders/${orderIdParam}` }],
        },
      }

      return new Response(JSON.stringify(trackingRecord), {
        status: 201,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        },
      })
    } catch (err: any) {
      return wcErrorResponse(
        'woocommerce_rest_tracking_create_error',
        err.message || 'Failed to save tracking record',
        500
      )
    }
  }

  return wcErrorResponse('woocommerce_rest_invalid_method', 'Method not allowed', 405)
}
