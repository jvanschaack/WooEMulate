/**
 * WooEMulate Reports Handler
 * Reports computed from adapter data. Values are real counts and sums, never placeholders.
 * Sales and top-seller reports page through matching orders, up to MAX_REPORT_ORDERS.
 */

import { wcErrorResponse } from '../auth.js'
import { formatLocal, wallTimeToDate } from '../dates.js'
import { ParamErrors, errorMessage, jsonResponse, parseEnum, routeUrl, type RouteContext } from '../http.js'
import { serializeWcOrder } from '../serializer.js'
import type { WooEmulateConfig, WooEmulateOrder } from '../types.js'

const ORDER_STATUS_NAMES: Array<[string, string]> = [
  ['pending', 'Pending payment'],
  ['processing', 'Processing'],
  ['on-hold', 'On hold'],
  ['completed', 'Completed'],
  ['cancelled', 'Cancelled'],
  ['refunded', 'Refunded'],
  ['failed', 'Failed'],
]

/** Statuses WooCommerce's sales reports count. */
const SALES_STATUSES = ['completed', 'processing', 'on-hold', 'refunded']
export const MAX_REPORT_ORDERS = 5000

export const REPORTS: Array<{ slug: string; description: string; enabled(config: WooEmulateConfig): boolean }> = [
  { slug: 'sales', description: 'List of sales reports.', enabled: () => true },
  { slug: 'top_sellers', description: 'List of top sellers products.', enabled: () => true },
  { slug: 'orders/totals', description: 'Orders totals.', enabled: () => true },
  { slug: 'products/totals', description: 'Products totals.', enabled: (c) => Boolean(c.adapter.products?.listProducts) },
  { slug: 'customers/totals', description: 'Customers totals.', enabled: (c) => Boolean(c.adapter.reports?.customersTotals) },
]

export async function listReports(ctx: RouteContext): Promise<Response> {
  return jsonResponse(
    REPORTS.filter((report) => report.enabled(ctx.config)).map((report) => ({
      slug: report.slug,
      description: report.description,
      _links: {
        self: [{ href: routeUrl(ctx, `/reports/${report.slug}`) }],
        collection: [{ href: routeUrl(ctx, '/reports') }],
      },
    }))
  )
}

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

export async function productsTotalsReport(ctx: RouteContext): Promise<Response> {
  const types: Array<[string, string]> = [
    ['external', 'External/Affiliate product'],
    ['grouped', 'Grouped product'],
    ['simple', 'Simple product'],
    ['variable', 'Variable product'],
  ]
  try {
    const totals = await Promise.all(
      types.map(async ([slug, name]) => {
        const { totalCount } = await ctx.config.adapter.products!.listProducts({
          type: slug as 'simple',
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

export async function customersTotalsReport(ctx: RouteContext): Promise<Response> {
  try {
    const { paying, nonPaying } = await ctx.config.adapter.reports!.customersTotals!()
    return jsonResponse([
      { slug: 'paying', name: 'Paying customer', total: paying },
      { slug: 'non_paying', name: 'Non-paying customer', total: nonPaying },
    ])
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_reports_error', errorMessage(err, 'Failed to compute report'), 500)
  }
}

interface ReportRange {
  start: Date
  end: Date
  buckets: string[]
  groupBy: 'day' | 'month'
}

/** About ten years of daily buckets. */
const MAX_REPORT_DAYS = 3660

function isCalendarDate(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return false
  const [y, m, d] = match.slice(1).map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  // Years stay within 1970-9998 so the exclusive end date (one day later) still has four digits.
  return y >= 1970 && y <= 9998 && date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

function dayNumber(ymd: string): number {
  return Date.parse(`${ymd}T00:00:00Z`) / 86_400_000
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** Resolves `period` / `date_min` / `date_max` to an absolute range in the store time zone. */
function reportRange(ctx: RouteContext, errors: ParamErrors): ReportRange | null {
  const query = ctx.url.searchParams
  const timeZone = ctx.config.store.timezone || 'UTC'
  const period = parseEnum(errors, 'period', query.get('period'), ['week', 'month', 'last_month', 'year'] as const)
  const dateMin = query.get('date_min')
  const dateMax = query.get('date_max')
  for (const [name, value] of [['date_min', dateMin], ['date_max', dateMax]] as const) {
    if (value && !isCalendarDate(value)) errors.add(name, `${name} must be a valid date in YYYY-MM-DD format.`)
  }
  if (errors.any) return null

  const today = formatLocal(new Date(), timeZone).slice(0, 10)
  const monthStart = today.slice(0, 8) + '01'
  let first: string
  let last: string
  let groupBy: 'day' | 'month' = 'day'
  if (dateMin || dateMax) {
    first = dateMin || dateMax!
    last = dateMax || today
    if (last < first) [first, last] = [last, first]
  } else if (period === 'month') {
    first = monthStart
    last = today
  } else if (period === 'last_month') {
    first = addDays(monthStart, -1).slice(0, 8) + '01'
    last = addDays(monthStart, -1)
  } else if (period === 'year') {
    first = today.slice(0, 4) + '-01-01'
    last = today
    groupBy = 'month'
  } else {
    first = addDays(today, -6)
    last = today
  }

  if (dayNumber(last) - dayNumber(first) > MAX_REPORT_DAYS) {
    errors.add('date_max', `The report range cannot exceed ${MAX_REPORT_DAYS} days.`)
    return null
  }
  const buckets: string[] = []
  for (let day = first; day <= last; day = addDays(day, 1)) buckets.push(day)
  if ((dateMin || dateMax) && buckets.length > 31) groupBy = 'month'
  const start = wallTimeToDate(`${first}T00:00:00`, timeZone)
  const end = wallTimeToDate(`${addDays(last, 1)}T00:00:00`, timeZone)
  if (!start || !end) {
    errors.add('date_max', 'Invalid report range.')
    return null
  }
  return {
    start,
    end,
    buckets: groupBy === 'month' ? [...new Set(buckets.map((day) => day.slice(0, 7)))] : buckets,
    groupBy,
  }
}

class ReportTooLarge extends Error {}

async function collectOrders(ctx: RouteContext, range: ReportRange): Promise<WooEmulateOrder[]> {
  const orders: WooEmulateOrder[] = []
  for (let offset = 0; ; offset += 100) {
    const { orders: page, totalCount } = await ctx.config.adapter.listOrders({
      status: SALES_STATUSES,
      after: new Date(range.start.getTime() - 1).toISOString(),
      before: range.end.toISOString(),
      page: offset / 100 + 1,
      perPage: 100,
      offset,
      order: 'asc',
      orderby: 'date',
    })
    orders.push(...(page || []))
    if (orders.length > MAX_REPORT_ORDERS) throw new ReportTooLarge()
    if (!page || page.length < 100 || offset + 100 >= (totalCount || 0)) return orders
  }
}

const cents = (value: string) => Math.round(Number(value) * 100)
const money = (value: number) => (value / 100).toFixed(2)

function reportFailure(err: unknown): Response {
  if (err instanceof ReportTooLarge) {
    return wcErrorResponse(
      'woocommerce_rest_report_too_large',
      `The report range contains more than ${MAX_REPORT_ORDERS} orders. Choose a shorter range.`,
      400
    )
  }
  return wcErrorResponse('woocommerce_rest_reports_error', errorMessage(err, 'Failed to compute report'), 500)
}

export async function salesReport(ctx: RouteContext): Promise<Response> {
  const errors = new ParamErrors()
  const range = reportRange(ctx, errors)
  if (!range) return errors.response()
  try {
    const timeZone = ctx.config.store.timezone || 'UTC'
    const totals: Record<string, { sales: number; orders: number; items: number; tax: number; shipping: number; discount: number; customers: Set<string> }> = {}
    for (const bucket of range.buckets) {
      totals[bucket] = { sales: 0, orders: 0, items: 0, tax: 0, shipping: 0, discount: 0, customers: new Set() }
    }
    let gross = 0, refunds = 0, cartTax = 0, shippingTax = 0, shipping = 0, discount = 0, items = 0
    const customers = new Set<string>()
    const orders = await collectOrders(ctx, range)
    for (const order of orders) {
      const data = serializeWcOrder(order, ctx.config.store)
      const orderItems = (order.items || []).reduce((sum, item) => sum + (item.quantity || 0), 0)
      const orderCartTax = cents(data.cart_tax)
      const orderShippingTax = cents(data.shipping_tax)
      const orderShipping = cents(data.shipping_total)
      const orderDiscount = cents(data.discount_total)
      const buyer = order.customerId ? `id:${order.customerId}` : order.customer?.email || order.billingAddress?.email || ''
      gross += order.totalCents
      refunds += (order.refunds || []).reduce((sum, refund) => sum + refund.totalCents, 0)
      cartTax += orderCartTax
      shippingTax += orderShippingTax
      shipping += orderShipping
      discount += orderDiscount
      items += orderItems
      if (buyer) customers.add(buyer)

      const day = formatLocal(new Date(data.date_created_gmt + 'Z'), timeZone).slice(0, 10)
      const bucket = totals[range.groupBy === 'month' ? day.slice(0, 7) : day]
      if (!bucket) continue
      bucket.sales += order.totalCents - orderShipping - orderCartTax - orderShippingTax
      bucket.orders += 1
      bucket.items += orderItems
      bucket.tax += orderCartTax + orderShippingTax
      bucket.shipping += orderShipping
      bucket.discount += orderDiscount
      if (buyer) bucket.customers.add(buyer)
    }
    const totalSales = gross - refunds
    const netSales = totalSales - shipping - Math.max(0, cartTax) - Math.max(0, shippingTax)
    return jsonResponse([
      {
        total_sales: money(totalSales),
        net_sales: money(netSales),
        average_sales: money(Math.round(netSales / Math.max(1, range.buckets.length))),
        total_orders: orders.length,
        total_items: items,
        total_tax: money(cartTax + shippingTax),
        total_shipping: money(shipping),
        total_refunds: refunds / 100,
        total_discount: money(discount),
        totals_grouped_by: range.groupBy,
        totals: Object.fromEntries(
          Object.entries(totals).map(([key, row]) => [
            key,
            {
              sales: money(row.sales),
              orders: row.orders,
              items: row.items,
              tax: money(row.tax),
              shipping: money(row.shipping),
              discount: money(row.discount),
              customers: row.customers.size,
            },
          ])
        ),
        // Distinct customers (by customer ID or email) with orders in the range.
        total_customers: customers.size,
      },
    ])
  } catch (err) {
    return reportFailure(err)
  }
}

export async function topSellersReport(ctx: RouteContext): Promise<Response> {
  const errors = new ParamErrors()
  const range = reportRange(ctx, errors)
  if (!range) return errors.response()
  try {
    const sellers = new Map<string, { title: string; product_id: number; quantity: number }>()
    for (const order of await collectOrders(ctx, range)) {
      for (const item of order.items || []) {
        const key = item.productId ? `id:${item.productId}` : `name:${item.parentName || item.name}`
        const row = sellers.get(key) ?? { title: item.parentName || item.name, product_id: item.productId ?? 0, quantity: 0 }
        row.quantity += item.quantity || 0
        sellers.set(key, row)
      }
    }
    const top = [...sellers.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 12)
    return jsonResponse(
      top.map((row) => ({
        ...row,
        _links: row.product_id ? { product: [{ href: routeUrl(ctx, `/products/${row.product_id}`) }] } : {},
      }))
    )
  } catch (err) {
    return reportFailure(err)
  }
}
