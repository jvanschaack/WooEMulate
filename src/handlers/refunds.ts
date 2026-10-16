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

  // Order line items are matched by the IDs the order response exposes.
  const orderLines = serializeWcOrder(order, ctx.config.store).line_items as Array<{ id: number; quantity: number }>
  const lineItems: WooEmulateRefundInput['lineItems'] = []
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
    const line = orderLines.find((row) => row.id === lineItemId)
    if (!line) errors.add(`line_items[${index}][id]`, 'Invalid line item ID.')
    else if (quantity > line.quantity) errors.add(`line_items[${index}][quantity]`, 'Quantity exceeds the ordered quantity.')
    lineItems.push({ lineItemId, quantity, refundTotalCents, refundTaxCents })
  }
  if (errors.any) return errors.response()

  const amountCents =
    typeof amount === 'number' ? amount : lineItems.reduce((sum, item) => sum + item.refundTotalCents + item.refundTaxCents, 0)
  if (amountCents <= 0) return refundError('Refund amount must be greater than zero.')

  try {
    const refunded = (await existingRefunds(ctx, order)).reduce((sum, refund) => sum + refund.amountCents, 0) ||
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
