/**
 * WooEMulate Orders Handler
 * Handles order listing, single order fetch, and order status updates.
 */

import { wcErrorResponse } from '../auth.js'
import { mapFromWcStatus } from '../helpers.js'
import {
  ParamErrors,
  errorMessage,
  jsonResponse,
  paginationHeaders,
  parseEnum,
  parseIdList,
  parseInteger,
  parseListParams,
  readList,
  type RouteContext,
} from '../http.js'
import { findOrderByApiId } from '../order-lookup.js'
import { serializeWcOrder } from '../serializer.js'
import type { WooEmulateListOrdersParams } from '../types.js'

export const ORDER_ORDERBY = ['date', 'id', 'include', 'title', 'slug', 'modified'] as const
export const ORDER_STATUSES = [
  'pending',
  'processing',
  'on-hold',
  'completed',
  'cancelled',
  'refunded',
  'failed',
] as const

/** Reads the `dp` (decimal places) parameter shared by order endpoints. */
export function readDecimalPlaces(ctx: RouteContext, errors: ParamErrors): number {
  return parseInteger(errors, 'dp', ctx.url.searchParams.get('dp'), { min: 0, max: 10 }) ?? 2
}

export function orderSerializeOptions(ctx: RouteContext, dp = 2) {
  return { version: ctx.version, apiBase: `${ctx.apiBase}/${ctx.namespace}`, dp }
}

export async function listOrders(ctx: RouteContext): Promise<Response> {
  const { config, url } = ctx
  const errors = new ParamErrors()
  const list = parseListParams(ctx, errors, {
    orderby: ORDER_ORDERBY,
    defaultOrderby: 'date',
    dates: true,
    modified: true,
  })
  const customer = parseInteger(errors, 'customer', url.searchParams.get('customer'), { min: 0 })
  const product = parseInteger(errors, 'product', url.searchParams.get('product'), { min: 0 })
  const parent = parseIdList(errors, url, 'parent')
  const dp = readDecimalPlaces(ctx, errors)
  if (errors.any) return errors.response()

  const params: WooEmulateListOrdersParams = { ...list }
  const statuses = readList(url, 'status')
  if (statuses?.length && !statuses.includes('any') && !statuses.includes('all')) {
    params.status = statuses.length === 1 ? statuses[0] : statuses
  }
  if (customer !== undefined) params.customer = customer
  if (product !== undefined) params.product = product
  if (parent) params.parent = parent

  try {
    const { orders, totalCount, totalPages } = await config.adapter.listOrders(params)
    const options = orderSerializeOptions(ctx, dp)
    const serialized = (orders || []).map((order) => serializeWcOrder(order, config.store, options))
    return jsonResponse(
      serialized,
      200,
      paginationHeaders(ctx, { page: list.page, perPage: list.perPage, total: totalCount || 0, totalPages })
    )
  } catch (err) {
    return wcErrorResponse(
      'woocommerce_rest_orders_error',
      errorMessage(err, 'Internal server error while fetching orders'),
      500
    )
  }
}

export async function getOrder(ctx: RouteContext): Promise<Response> {
  const errors = new ParamErrors()
  const dp = readDecimalPlaces(ctx, errors)
  if (errors.any) return errors.response()
  try {
    const order = await findOrderByApiId(ctx.config, ctx.params.id)
    if (!order) {
      return wcErrorResponse('woocommerce_rest_shop_order_invalid_id', 'Invalid ID.', 404)
    }
    return jsonResponse(serializeWcOrder(order, ctx.config.store, orderSerializeOptions(ctx, dp)))
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_order_error', errorMessage(err, 'Failed to retrieve order'), 500)
  }
}

export async function updateOrder(ctx: RouteContext): Promise<Response> {
  const { config } = ctx
  try {
    const order = await findOrderByApiId(config, ctx.params.id)
    if (!order) {
      return wcErrorResponse('woocommerce_rest_shop_order_invalid_id', 'Invalid ID.', 404)
    }

    const body = await ctx.input()
    const errors = new ParamErrors()
    const status =
      body.status === undefined || body.status === null
        ? undefined
        : parseEnum(errors, 'status', String(body.status).replace(/^wc-/, ''), ORDER_STATUSES)
    const dp = readDecimalPlaces(ctx, errors)
    if (errors.any) return errors.response()

    // 1. Status update
    if (status && config.adapter.updateOrderStatus) {
      await config.adapter.updateOrderStatus(order.id, mapFromWcStatus(status))
    }

    // 2. Tracking updates via meta_data or direct fields
    let trackingNumber = String(body.tracking_number || '').trim()
    let carrier = String(body.tracking_provider || body.carrier || '').trim()
    let dateShipped = String(body.date_shipped || '').trim()

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

    // Return the refreshed order, re-resolved by API ID so it is verified to be the same order.
    const updated = await findOrderByApiId(config, ctx.params.id)
    return jsonResponse(serializeWcOrder(updated || order, config.store, orderSerializeOptions(ctx, dp)))
  } catch (err) {
    return wcErrorResponse(
      'woocommerce_rest_order_update_error',
      errorMessage(err, 'Failed to update order'),
      500
    )
  }
}
