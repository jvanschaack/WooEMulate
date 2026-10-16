/**
 * WooEMulate Customers and Coupons Handlers
 * Read-only customer and coupon collections backed by optional adapter sections.
 */

import { wcErrorResponse } from '../auth.js'
import { ParamErrors, errorMessage, jsonResponse, paginationHeaders, parseListParams, type RouteContext } from '../http.js'
import { findByApiId } from '../order-lookup.js'
import { serializeWcCoupon, serializeWcCustomer } from '../serializers/customers.js'
import type { WooEmulateListCouponsParams, WooEmulateListCustomersParams } from '../types.js'

function options(ctx: RouteContext) {
  return { version: ctx.version, apiBase: `${ctx.apiBase}/${ctx.namespace}` }
}

export async function listCustomers(ctx: RouteContext): Promise<Response> {
  const errors = new ParamErrors()
  const list = parseListParams(ctx, errors, {
    orderby: ['id', 'include', 'name', 'registered_date'] as const,
    defaultOrderby: 'name',
    defaultOrder: 'asc',
  })
  const email = ctx.url.searchParams.get('email') || undefined
  if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) errors.add('email', 'Invalid email address.')
  if (errors.any) return errors.response()
  const params: WooEmulateListCustomersParams = { ...list }
  if (email) params.email = email
  const role = ctx.url.searchParams.get('role')
  if (role && role !== 'all') params.role = role
  try {
    const { customers, totalCount, totalPages } = await ctx.config.adapter.customers!.listCustomers(params)
    return jsonResponse(
      (customers || []).map((customer) => serializeWcCustomer(customer, ctx.config.store, options(ctx))),
      200,
      paginationHeaders(ctx, { page: list.page, perPage: list.perPage, total: totalCount || 0, totalPages })
    )
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_customers_error', errorMessage(err, 'Failed to list customers.'), 500)
  }
}

export async function getCustomer(ctx: RouteContext): Promise<Response> {
  try {
    const customer = await findByApiId(ctx.params.id, (id) => ctx.config.adapter.customers!.getCustomer(id))
    return customer
      ? jsonResponse(serializeWcCustomer(customer, ctx.config.store, options(ctx)))
      : wcErrorResponse('woocommerce_rest_invalid_id', 'Invalid resource ID.', 404)
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_customer_error', errorMessage(err, 'Failed to retrieve customer.'), 500)
  }
}

export async function listCoupons(ctx: RouteContext): Promise<Response> {
  const errors = new ParamErrors()
  const list = parseListParams(ctx, errors, {
    orderby: ['date', 'id', 'include', 'title', 'slug', 'modified'] as const,
    defaultOrderby: 'date',
    dates: true,
    modified: true,
  })
  if (errors.any) return errors.response()
  const params: WooEmulateListCouponsParams = { ...list }
  const code = ctx.url.searchParams.get('code')
  if (code) params.code = code
  try {
    const { coupons, totalCount, totalPages } = await ctx.config.adapter.coupons!.listCoupons(params)
    return jsonResponse(
      (coupons || []).map((coupon) => serializeWcCoupon(coupon, ctx.config.store, options(ctx))),
      200,
      paginationHeaders(ctx, { page: list.page, perPage: list.perPage, total: totalCount || 0, totalPages })
    )
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_coupons_error', errorMessage(err, 'Failed to list coupons.'), 500)
  }
}

export async function getCoupon(ctx: RouteContext): Promise<Response> {
  try {
    const coupon = await findByApiId(ctx.params.id, (id) => ctx.config.adapter.coupons!.getCoupon(id))
    return coupon
      ? jsonResponse(serializeWcCoupon(coupon, ctx.config.store, options(ctx)))
      : wcErrorResponse('woocommerce_rest_shop_coupon_invalid_id', 'Invalid ID.', 404)
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_coupon_error', errorMessage(err, 'Failed to retrieve coupon.'), 500)
  }
}
