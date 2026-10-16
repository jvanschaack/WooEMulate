/**
 * WooEMulate Reports Handler
 * Report totals computed from adapter data. Values are real counts, never placeholders.
 */

import { wcErrorResponse } from '../auth.js'
import { errorMessage, jsonResponse, type RouteContext } from '../http.js'

const ORDER_STATUS_NAMES: Array<[string, string]> = [
  ['pending', 'Pending payment'],
  ['processing', 'Processing'],
  ['on-hold', 'On hold'],
  ['completed', 'Completed'],
  ['cancelled', 'Cancelled'],
  ['refunded', 'Refunded'],
  ['failed', 'Failed'],
]

export async function ordersTotalsReport(ctx: RouteContext): Promise<Response> {
  try {
    const totals = await Promise.all(
      ORDER_STATUS_NAMES.map(async ([slug, name]) => {
        const { totalCount } = await ctx.config.adapter.listOrders({
          status: slug,
          page: 1,
          perPage: 1,
          offset: 0,
          order: 'desc',
          orderby: 'date',
        })
        return { slug, name, total: totalCount || 0 }
      })
    )
    return jsonResponse(totals)
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_reports_error', errorMessage(err, 'Failed to compute report'), 500)
  }
}
