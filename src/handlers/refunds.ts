/**
 * WooEMulate Refunds Handler
 * Order refunds: reads, and opt-in creation through `createOrderRefund`.
 */

import { wcErrorResponse } from '../auth.js'
import {
  ParamErrors,
  errorMessage,
  jsonResponse,
  paginateInMemory,
  paginationHeaders,
  parseBoolean,
  parseInteger,
  parseListParams,
  parseMoney,
  type RouteContext,
} from '../http.js'
import { findOrderByApiId } from '../order-lookup.js'
import { serializeWcOrder } from '../serializer.js'
import { serializeWcRefund } from '../serializers/customers.js'
import { toDate } from '../dates.js'
import type { WooEmulateOrder, WooEmulateRefund, WooEmulateRefundInput } from '../types.js'
import { readDecimalPlaces } from './orders.js'

async function loadOrder(ctx: RouteContext): Promise<WooEmulateOrder | Response> {
  try {
    const order = await findOrderByApiId(ctx.config, ctx.params.order_id)
    return order ?? wcErrorResponse('woocommerce_rest_order_invalid_id', 'Invalid order ID.', 404)
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_order_error', errorMessage(err, 'Failed to retrieve order.'), 500)
  }
}

function serialize(ctx: RouteContext, refund: WooEmulateRefund, dp: number) {
  return serializeWcRefund(refund, ctx.config.store, {
    version: ctx.version,
    apiBase: `${ctx.apiBase}/${ctx.namespace}`,
    orderId: Number(ctx.params.order_id),
    dp,
  })
}

async function existingRefunds(ctx: RouteContext, order: WooEmulateOrder): Promise<WooEmulateRefund[]> {
  return ctx.config.adapter.listOrderRefunds ? ctx.config.adapter.listOrderRefunds(order.id) : []
}

export async function listRefunds(ctx: RouteContext): Promise<Response> {
  const errors = new ParamErrors()
  const params = parseListParams(ctx, errors, {
    orderby: ['date', 'id', 'include', 'title', 'slug', 'modified'] as const,
    defaultOrderby: 'date',
    dates: true,
  })
  const dp = readDecimalPlaces(ctx, errors)
  if (errors.any) return errors.response()
  const order = await loadOrder(ctx)
  if (order instanceof Response) return order
  try {
    const time = (refund: WooEmulateRefund) => toDate(refund.createdAt)?.getTime() ?? 0
    let rows = await existingRefunds(ctx, order)
    if (params.after) rows = rows.filter((refund) => time(refund) > Date.parse(params.after!))
    if (params.before) rows = rows.filter((refund) => time(refund) < Date.parse(params.before!))
    const page = paginateInMemory(rows, params, {
      id: (refund) => refund.id,
      search: (refund) => [refund.reason ?? ''],
      sort: (refund) => time(refund),
    })
    return jsonResponse(
      page.items.map((refund) => serialize(ctx, refund, dp)),
      200,
      paginationHeaders(ctx, { page: params.page, perPage: params.perPage, total: page.total })
    )
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_refunds_error', errorMessage(err, 'Failed to list refunds.'), 500)
  }
}

export async function getRefund(ctx: RouteContext): Promise<Response> {
  const errors = new ParamErrors()
  const dp = readDecimalPlaces(ctx, errors)
  if (errors.any) return errors.response()
  const order = await loadOrder(ctx)
  if (order instanceof Response) return order
  try {
    const refund = (await existingRefunds(ctx, order)).find((row) => String(row.id) === ctx.params.id)
    return refund ? jsonResponse(serialize(ctx, refund, dp)) : wcErrorResponse('woocommerce_rest_invalid_id', 'Invalid resource ID.', 404)
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_refunds_error', errorMessage(err, 'Failed to read refund.'), 500)
  }
}

function refundError(message: string, status = 400): Response {
  return wcErrorResponse('woocommerce_rest_cannot_create_order_refund', message, status)
}

export async function createRefund(ctx: RouteContext): Promise<Response> {
  const order = await loadOrder(ctx)
  if (order instanceof Response) return order
  const input = await ctx.input()
  const errors = new ParamErrors()
  const dp = readDecimalPlaces(ctx, errors)
  const amount = parseMoney(errors, 'amount', input.amount)
  const refundPayment = parseBoolean(errors, 'api_refund', input.api_refund) ?? true
  const restockItems = parseBoolean(errors, 'api_restock', input.api_restock) ?? true
  const refundedBy = parseInteger(errors, 'refunded_by', input.refunded_by, { min: 0 })

  // Refund entries reference the item IDs the order response exposes: line items, and also
  // shipping and fee lines (no quantity), as WooCommerce allows. Repeated IDs are merged so the
  // quantity check covers the whole request.
  const serialized = serializeWcOrder(order, ctx.config.store)
  const orderLines = serialized.line_items as Array<{ id: number; quantity: number }>
  const otherLineIds = new Set<number>([
    ...(serialized.shipping_lines as Array<{ id: number }>).map((line) => line.id),
    ...(serialized.fee_lines as Array<{ id: number }>).map((line) => line.id),
  ])
  const merged = new Map<number, WooEmulateRefundInput['lineItems'][number] & { index: number }>()
  if (input.line_items !== undefined && !Array.isArray(input.line_items)) errors.add('line_items', 'line_items is not of type array.')
  for (const [index, item] of (Array.isArray(input.line_items) ? input.line_items : []).entries()) {
    const lineItemId = parseInteger(errors, `line_items[${index}][id]`, item?.id, { min: 1 })
    const quantity = parseInteger(errors, `line_items[${index}][quantity]`, item?.quantity ?? 0, { min: 0 }) ?? 0
    const refundTotalCents = parseMoney(errors, `line_items[${index}][refund_total]`, item?.refund_total ?? '0') ?? 0
    const taxes = Array.isArray(item?.refund_tax) ? item.refund_tax : []
    const refundTaxCents = taxes.reduce(
      (sum: number, tax: any, taxIndex: number) =>
        sum + (parseMoney(errors, `line_items[${index}][refund_tax][${taxIndex}]`, tax?.refund_total ?? '0') ?? 0),
      0
    )
    if (lineItemId === undefined) continue
    const previous = merged.get(lineItemId)
    merged.set(lineItemId, {
      index: previous?.index ?? index,
      lineItemId,
      quantity: (previous?.quantity ?? 0) + quantity,
      refundTotalCents: (previous?.refundTotalCents ?? 0) + refundTotalCents,
      refundTaxCents: (previous?.refundTaxCents ?? 0) + refundTaxCents,
    })
  }
  let prior: WooEmulateRefund[]
  try {
    prior = await existingRefunds(ctx, order)
  } catch (err) {
    return refundError(errorMessage(err, 'Failed to read existing refunds.'), 500)
  }
  // Units already refunded (and possibly restocked) cannot be refunded again.
  const refundedQuantity = new Map<number, number>()
  for (const refund of prior) {
    for (const item of refund.lineItems ?? []) {
      if (item.refundedItemId) {
        refundedQuantity.set(item.refundedItemId, (refundedQuantity.get(item.refundedItemId) ?? 0) + Math.abs(item.quantity))
      }
    }
  }
  const lineItems: WooEmulateRefundInput['lineItems'] = []
  for (const { index, ...item } of merged.values()) {
    const line = orderLines.find((row) => row.id === item.lineItemId)
    if (!line && !otherLineIds.has(item.lineItemId)) errors.add(`line_items[${index}][id]`, 'Invalid line item ID.')
    else if (line && item.quantity > line.quantity - (refundedQuantity.get(item.lineItemId) ?? 0)) {
      errors.add(`line_items[${index}][quantity]`, 'Quantity exceeds the remaining refundable quantity.')
    }
    lineItems.push(item)
  }
  if (errors.any) return errors.response()

  const amountCents =
    typeof amount === 'number' ? amount : lineItems.reduce((sum, item) => sum + item.refundTotalCents + item.refundTaxCents, 0)
  if (amountCents <= 0) return refundError('Refund amount must be greater than zero.')
  if (!Number.isFinite(order.totalCents)) return refundError('Invalid refund amount.')

  try {
    const refunded = prior.reduce((sum, refund) => sum + refund.amountCents, 0) ||
      (order.refunds ?? []).reduce((sum, refund) => sum + refund.totalCents, 0)
    if (amountCents > order.totalCents - refunded) return refundError('Invalid refund amount.')

    const refund = await ctx.config.adapter.createOrderRefund!(order.id, {
      amountCents,
      reason: input.reason == null ? '' : String(input.reason),
      refundPayment,
      restockItems,
      lineItems,
      ...(refundedBy !== undefined ? { refundedBy } : {}),
    })
    return jsonResponse(serialize(ctx, refund, dp), 201, {
      Location: `${ctx.apiBase}/${ctx.namespace}/orders/${ctx.params.order_id}/refunds/${refund.id}`,
    })
  } catch (err) {
    return refundError(errorMessage(err, 'Failed to create refund.'), 500)
  }
}
