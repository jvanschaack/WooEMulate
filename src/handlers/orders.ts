/**
 * WooEMulate Orders Handler
 * Handles order listing, single order fetch, and order status updates.
 */

import { authenticateRequest, wcErrorResponse } from '../auth.js'
import { mapFromWcStatus } from '../helpers.js'
import { serializeWcOrder } from '../serializer.js'
import type { WooEmulateConfig, WooEmulateListOrdersParams } from '../types.js'

export async function handleOrders(
  config: WooEmulateConfig,
  request: Request,
  orderIdParam?: string
): Promise<Response> {
  const auth = await authenticateRequest(request, config)
  if (!auth.authenticated) {
    return wcErrorResponse(
      'woocommerce_rest_cannot_view',
      auth.error || 'Authentication required',
      auth.status || 401
    )
  }

  // 1. Single Order operations (/orders/:id)
  if (orderIdParam) {
    if (request.method === 'GET') {
      return handleGetSingleOrder(config, orderIdParam)
    }
    if (request.method === 'PUT' || request.method === 'POST') {
      return handleUpdateSingleOrder(config, request, orderIdParam)
    }
    return wcErrorResponse('woocommerce_rest_invalid_method', 'Method not allowed', 405)
  }

  // 2. Orders list (/orders)
  if (request.method === 'GET') {
    return handleListOrders(config, request)
  }

  return wcErrorResponse('woocommerce_rest_invalid_method', 'Method not allowed', 405)
}

async function handleListOrders(config: WooEmulateConfig, request: Request): Promise<Response> {
  try {
    const url = new URL(request.url)
    const params = url.searchParams

    const statusParam = params.get('status')
    const page = Math.max(parseInt(params.get('page') || '1', 10), 1)
    const perPage = Math.min(Math.max(parseInt(params.get('per_page') || '50', 10), 1), 100)
    const after = params.get('after') || undefined
    const before = params.get('before') || undefined
    const search = params.get('search') || undefined
    const order = (params.get('order')?.toLowerCase() === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc'
    const orderby = (params.get('orderby')?.toLowerCase() || 'date') as 'date' | 'id' | 'title'

    const queryParams: WooEmulateListOrdersParams = {
      page,
      perPage,
      after,
      before,
      search,
      order,
      orderby,
    }

    if (statusParam && statusParam !== 'any' && statusParam !== 'all') {
      queryParams.status = statusParam.includes(',')
        ? statusParam.split(',').map((s) => s.trim())
        : statusParam.trim()
    }

    const { orders, totalCount, totalPages } = await config.adapter.listOrders(queryParams)

    const serializedOrders = (orders || []).map((order) =>
      serializeWcOrder(order, config.store)
    )

    const calculatedTotalPages = totalPages || Math.ceil((totalCount || 0) / perPage) || 1

    return new Response(JSON.stringify(serializedOrders), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-WP-Total': String(totalCount || 0),
        'X-WP-TotalPages': String(calculatedTotalPages),
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'X-WP-Total, X-WP-TotalPages',
      },
    })
  } catch (err: any) {
    return wcErrorResponse(
      'woocommerce_rest_orders_error',
      err.message || 'Internal server error while fetching orders',
      500
    )
  }
}

async function handleGetSingleOrder(
  config: WooEmulateConfig,
  orderIdParam: string
): Promise<Response> {
  try {
    const order = await config.adapter.getOrder(orderIdParam)
    if (!order) {
      return wcErrorResponse('woocommerce_rest_order_invalid_id', 'Invalid order ID.', 404)
    }

    const serialized = serializeWcOrder(order, config.store)
    return new Response(JSON.stringify(serialized), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch (err: any) {
    return wcErrorResponse(
      'woocommerce_rest_order_error',
      err.message || 'Failed to retrieve order',
      500
    )
  }
}

async function handleUpdateSingleOrder(
  config: WooEmulateConfig,
  request: Request,
  orderIdParam: string
): Promise<Response> {
  try {
    const order = await config.adapter.getOrder(orderIdParam)
    if (!order) {
      return wcErrorResponse('woocommerce_rest_order_invalid_id', 'Invalid order ID.', 404)
    }

    const body = await request.json().catch(() => ({}))

    // 1. Status update
    if (body.status && config.adapter.updateOrderStatus) {
      const normalizedStatus = mapFromWcStatus(body.status)
      await config.adapter.updateOrderStatus(order.id, normalizedStatus)
    }

    // 2. Tracking updates via meta_data or direct fields
    let trackingNumber = (body.tracking_number || '').trim()
    let carrier = (body.tracking_provider || body.carrier || '').trim()
    let dateShipped = (body.date_shipped || '').trim()

    if (Array.isArray(body.meta_data)) {
      for (const item of body.meta_data) {
        if (!item || !item.key) continue
        const k = String(item.key).toLowerCase()
        if (k === '_tracking_number') trackingNumber = String(item.value || '').trim()
        if (k === '_tracking_provider') carrier = String(item.value || '').trim()
        if (k === '_date_shipped') dateShipped = String(item.value || '').trim()
      }
    }

    if (trackingNumber && config.adapter.onShipmentTrackingCreated) {
      await config.adapter.onShipmentTrackingCreated(order.id, {
        trackingNumber,
        carrier: carrier || undefined,
        dateShipped: dateShipped || undefined,
      })
    }

    // Return the refreshed order
    const updated = await config.adapter.getOrder(order.id)
    const serialized = serializeWcOrder(updated || order, config.store)

    return new Response(JSON.stringify(serialized), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch (err: any) {
    return wcErrorResponse(
      'woocommerce_rest_order_update_error',
      err.message || 'Failed to update order',
      500
    )
  }
}
