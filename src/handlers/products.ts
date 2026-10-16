/**
 * WooEMulate Products Handler
 * Product and variation reads, stock and price writes, and catalog taxonomies.
 * Product creation and other field edits are intentionally not supported: a changed field
 * outside stock and price is rejected rather than silently ignored.
 */

import { wcErrorResponse } from '../auth.js'
import {
  ParamErrors,
  errorMessage,
  handleBatch,
  jsonResponse,
  paginateInMemory,
  paginationHeaders,
  parseBoolean,
  parseEnum,
  parseIdList,
  parseInteger,
  parseListParams,
  parseMoney,
  readList,
  type RouteContext,
} from '../http.js'
import { findByApiId } from '../order-lookup.js'
import {
  productApiId,
  serializeWcAttribute,
  serializeWcAttributeTerm,
  serializeWcCategory,
  serializeWcProduct,
  serializeWcTag,
  serializeWcVariation,
} from '../serializers/products.js'
import type {
  WooEmulateCatalogListParams,
  WooEmulateListProductsParams,
  WooEmulateListVariationsParams,
  WooEmulateProduct,
  WooEmulateProductAdapter,
  WooEmulateProductVariation,
  WooEmulateStockPriceChanges,
} from '../types.js'

const PRODUCT_ORDERBY = ['date', 'id', 'include', 'title', 'slug', 'price', 'popularity', 'rating', 'modified', 'menu_order'] as const
const VARIATION_ORDERBY = ['date', 'id', 'include', 'title', 'slug', 'modified', 'menu_order'] as const
const STATUSES = ['any', 'draft', 'pending', 'private', 'publish'] as const
const STOCK_STATUSES = ['instock', 'outofstock', 'onbackorder'] as const
const TYPES = ['simple', 'grouped', 'external', 'variable'] as const

/** Fields WooCommerce treats as read-only; clients often echo them back on update. */
const READ_ONLY = new Set([
  'id', 'permalink', 'date_created', 'date_created_gmt', 'date_modified', 'date_modified_gmt', 'price', 'price_html',
  'on_sale', 'purchasable', 'total_sales', 'backorders_allowed', 'backordered', 'average_rating', 'rating_count',
  'related_ids', 'variations', 'has_options', '_links',
])
const WRITABLE = new Set(['manage_stock', 'stock_quantity', 'stock_status', 'regular_price', 'sale_price'])

/** JSON with object keys sorted, so echoed values compare equal regardless of key order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function catalog(ctx: RouteContext): WooEmulateProductAdapter {
  return ctx.config.adapter.products!
}

function options(ctx: RouteContext) {
  return { version: ctx.version, apiBase: `${ctx.apiBase}/${ctx.namespace}` }
}

function sameApiId(item: { id: string | number; wooCommerceId?: number }, apiId: number): boolean {
  try {
    return productApiId(item) === apiId
  } catch {
    return false
  }
}

function invalidProduct(): Response {
  return wcErrorResponse('woocommerce_rest_product_invalid_id', 'Invalid ID.', 404)
}

function invalidVariation(): Response {
  return wcErrorResponse('woocommerce_rest_product_variation_invalid_id', 'Invalid ID.', 404)
}

async function loadProduct(ctx: RouteContext, param = ctx.params.product_id ?? ctx.params.id) {
  return findByApiId(param, (id) => catalog(ctx).getProduct(id))
}

function catalogParams(
  ctx: RouteContext,
  errors: ParamErrors,
  orderby: readonly string[]
): WooEmulateCatalogListParams {
  const list = parseListParams(ctx, errors, { orderby, defaultOrderby: 'date', dates: true, modified: true })
  const query = ctx.url.searchParams
  const params: WooEmulateCatalogListParams = { ...list }
  const sku = readList(ctx.url, 'sku')
  if (sku?.length) params.sku = sku
  const status = parseEnum(errors, 'status', query.get('status'), STATUSES)
  if (status && status !== 'any') params.status = status
  const stockStatus = parseEnum(errors, 'stock_status', query.get('stock_status'), STOCK_STATUSES)
  if (stockStatus) params.stockStatus = stockStatus
  return params
}

/**
 * Converts an update body into stock and price changes. Unsupported fields are accepted only
 * when they repeat the current value, so clients that send the whole object back still work.
 */
function readStockPriceChanges(
  input: Record<string, any>,
  current: Record<string, any>
): WooEmulateStockPriceChanges | Response {
  const errors = new ParamErrors()
  const changes: WooEmulateStockPriceChanges = {}
  // Writable fields that repeat the current value are not changes. Otherwise an echoed
  // `stock_status` could overwrite the status implied by a new stock quantity.
  input = Object.fromEntries(
    Object.entries(input).filter(([key, value]) => !WRITABLE.has(key) || stableJson(value) !== stableJson(current[key]))
  )
  // v1/v2 clients write stock state through the boolean `in_stock`.
  if (input.in_stock !== undefined && 'in_stock' in current && input.stock_status === undefined) {
    const inStock = parseBoolean(errors, 'in_stock', input.in_stock)
    if (inStock !== undefined && inStock !== current.in_stock) changes.stockStatus = inStock ? 'instock' : 'outofstock'
    delete input.in_stock
  }
  const manage = input.manage_stock === 'parent' ? undefined : parseBoolean(errors, 'manage_stock', input.manage_stock)
  if (manage !== undefined) changes.manageStock = manage
  if (input.stock_quantity !== undefined) {
    if (input.stock_quantity === null || input.stock_quantity === '') changes.stockQuantity = null
    else {
      const quantity = parseInteger(errors, 'stock_quantity', input.stock_quantity)
      if (quantity !== undefined) changes.stockQuantity = quantity
    }
  }
  const stockStatus = parseEnum(errors, 'stock_status', input.stock_status, STOCK_STATUSES)
  if (stockStatus) changes.stockStatus = stockStatus
  const regular = parseMoney(errors, 'regular_price', input.regular_price)
  if (regular !== undefined) changes.regularPriceCents = regular
  const sale = parseMoney(errors, 'sale_price', input.sale_price)
  if (sale !== undefined) changes.salePriceCents = sale

  for (const [key, value] of Object.entries(input)) {
    if (WRITABLE.has(key) || READ_ONLY.has(key) || key === 'force' || key === 'context') continue
    if (stableJson(value) !== stableJson(current[key])) {
      errors.add(key, `${key} cannot be changed through this API; only stock and prices can be updated.`)
    }
  }
  return errors.any ? errors.response() : changes
}

export async function listProducts(ctx: RouteContext): Promise<Response> {
  const errors = new ParamErrors()
  const base = catalogParams(ctx, errors, PRODUCT_ORDERBY)
  const query = ctx.url.searchParams
  const params = base as WooEmulateListProductsParams
  const type = parseEnum(errors, 'type', query.get('type'), TYPES)
  if (type) params.type = type
  const category = parseInteger(errors, 'category', query.get('category'), { min: 0 })
  if (category !== undefined) params.category = category
  const tag = parseInteger(errors, 'tag', query.get('tag'), { min: 0 })
  if (tag !== undefined) params.tag = tag
  const parent = parseIdList(errors, ctx.url, 'parent')
  if (parent) params.parent = parent
  const featured = parseBoolean(errors, 'featured', query.get('featured') ?? undefined)
  if (featured !== undefined) params.featured = featured
  const onSale = parseBoolean(errors, 'on_sale', query.get('on_sale') ?? undefined)
  if (onSale !== undefined) params.onSale = onSale
  const min = parseMoney(errors, 'min_price', query.get('min_price') ?? undefined)
  if (typeof min === 'number') params.minPriceCents = min
  const max = parseMoney(errors, 'max_price', query.get('max_price') ?? undefined)
  if (typeof max === 'number') params.maxPriceCents = max
  if (errors.any) return errors.response()
  try {
    const { products, totalCount, totalPages } = await catalog(ctx).listProducts(params)
    return jsonResponse(
      (products || []).map((product) => serializeWcProduct(product, ctx.config.store, options(ctx))),
      200,
      paginationHeaders(ctx, { page: params.page, perPage: params.perPage, total: totalCount || 0, totalPages })
    )
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_products_error', errorMessage(err, 'Failed to list products.'), 500)
  }
}

export async function getProduct(ctx: RouteContext): Promise<Response> {
  try {
    const product = await loadProduct(ctx)
    return product ? jsonResponse(serializeWcProduct(product, ctx.config.store, options(ctx))) : invalidProduct()
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_product_error', errorMessage(err, 'Failed to retrieve product.'), 500)
  }
}

export async function updateProduct(ctx: RouteContext): Promise<Response> {
  try {
    const product = await loadProduct(ctx)
    if (!product) return invalidProduct()
    const current = serializeWcProduct(product, ctx.config.store, options(ctx))
    const changes = readStockPriceChanges(await ctx.input(), current)
    if (changes instanceof Response) return changes
    const apiId = productApiId(product)
    let updated: WooEmulateProduct | null = product
    if (Object.keys(changes).length) {
      const returned = await catalog(ctx).updateProduct!(product, changes)
      // Use the returned or re-read product only when it is verifiably the same product.
      updated = returned && sameApiId(returned, apiId) ? returned : await findByApiId(String(apiId), (id) => catalog(ctx).getProduct(id))
    }
    return jsonResponse(serializeWcProduct(updated || product, ctx.config.store, options(ctx)))
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_product_update_error', errorMessage(err, 'Failed to update product.'), 500)
  }
}

export async function batchProducts(ctx: RouteContext): Promise<Response> {
  return handleBatch(ctx, { update: updateProduct })
}

async function loadVariation(
  ctx: RouteContext,
  product: WooEmulateProduct
): Promise<WooEmulateProductVariation | null> {
  if (!catalog(ctx).getVariation) return null
  return findByApiId(ctx.params.id, (id) => catalog(ctx).getVariation!(product, id))
}

export async function listVariations(ctx: RouteContext): Promise<Response> {
  const errors = new ParamErrors()
  const params = catalogParams(ctx, errors, VARIATION_ORDERBY) as WooEmulateListVariationsParams
  if (errors.any) return errors.response()
  try {
    const product = await loadProduct(ctx)
    if (!product) return invalidProduct()
    const { variations, totalCount, totalPages } = await catalog(ctx).listVariations!(product, params)
    return jsonResponse(
      (variations || []).map((variation) => serializeWcVariation(variation, product, ctx.config.store, options(ctx))),
      200,
      paginationHeaders(ctx, { page: params.page, perPage: params.perPage, total: totalCount || 0, totalPages })
    )
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_variations_error', errorMessage(err, 'Failed to list variations.'), 500)
  }
}

export async function getVariation(ctx: RouteContext): Promise<Response> {
  try {
    const product = await loadProduct(ctx)
    if (!product) return invalidProduct()
    const variation = await loadVariation(ctx, product)
    return variation
      ? jsonResponse(serializeWcVariation(variation, product, ctx.config.store, options(ctx)))
      : invalidVariation()
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_variation_error', errorMessage(err, 'Failed to retrieve variation.'), 500)
  }
}

export async function updateVariation(ctx: RouteContext): Promise<Response> {
  try {
    const product = await loadProduct(ctx)
    if (!product) return invalidProduct()
    const variation = await loadVariation(ctx, product)
    if (!variation) return invalidVariation()
    const current = serializeWcVariation(variation, product, ctx.config.store, options(ctx))
    const changes = readStockPriceChanges(await ctx.input(), current)
    if (changes instanceof Response) return changes
    const apiId = productApiId(variation)
    let updated: WooEmulateProductVariation | null = variation
    if (Object.keys(changes).length) {
      const returned = await catalog(ctx).updateVariation!(product, variation, changes)
      updated = returned && sameApiId(returned, apiId)
        ? returned
        : await findByApiId(String(apiId), (id) => catalog(ctx).getVariation!(product, id))
    }
    return jsonResponse(serializeWcVariation(updated || variation, product, ctx.config.store, options(ctx)))
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_variation_update_error', errorMessage(err, 'Failed to update variation.'), 500)
  }
}

export async function batchVariations(ctx: RouteContext): Promise<Response> {
  return handleBatch(ctx, { update: updateVariation })
}

const TERM_ORDERBY = ['id', 'include', 'name', 'slug', 'term_group', 'description', 'count'] as const

async function listTerms<T extends { id: number; name: string; slug: string; description?: string; count?: number }>(
  ctx: RouteContext,
  load: () => Promise<T[]>,
  serialize: (item: T) => Record<string, any>,
  filter: (item: T, query: URLSearchParams, errors: ParamErrors) => boolean = () => true
): Promise<Response> {
  const errors = new ParamErrors()
  const params = parseListParams(ctx, errors, { orderby: TERM_ORDERBY, defaultOrderby: 'name', defaultOrder: 'asc' })
  const hideEmpty = parseBoolean(errors, 'hide_empty', ctx.url.searchParams.get('hide_empty') ?? undefined) ?? false
  const slug = ctx.url.searchParams.get('slug')
  if (errors.any) return errors.response()
  try {
    let rows = (await load()).filter((item) => filter(item, ctx.url.searchParams, errors))
    if (errors.any) return errors.response()
    if (hideEmpty) rows = rows.filter((item) => (item.count ?? 0) > 0)
    if (slug) rows = rows.filter((item) => item.slug === slug)
    const page = paginateInMemory(rows, params, {
      id: (item) => item.id,
      search: (item) => [item.name, item.slug, item.description ?? ''],
      sort: (item, orderby) =>
        orderby === 'count' ? item.count ?? 0 : orderby === 'slug' ? item.slug : orderby === 'description' ? item.description ?? '' : item.name,
    })
    return jsonResponse(
      page.items.map(serialize),
      200,
      paginationHeaders(ctx, { page: params.page, perPage: params.perPage, total: page.total })
    )
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_terms_error', errorMessage(err, 'Failed to list terms.'), 500)
  }
}

async function getTerm<T extends { id: number }>(
  ctx: RouteContext,
  load: () => Promise<T[]>,
  serialize: (item: T) => Record<string, any>,
  id = ctx.params.id
): Promise<Response> {
  try {
    const item = (await load()).find((row) => String(row.id) === id)
    return item ? jsonResponse(serialize(item)) : wcErrorResponse('woocommerce_rest_term_invalid', 'Resource does not exist.', 404)
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_terms_error', errorMessage(err, 'Failed to read term.'), 500)
  }
}

const apiBase = (ctx: RouteContext) => `${ctx.apiBase}/${ctx.namespace}`

export const listCategories = (ctx: RouteContext) =>
  listTerms(ctx, () => catalog(ctx).listCategories!(), (row) => serializeWcCategory(row, apiBase(ctx)), (row, query, errors) => {
    const parent = parseInteger(errors, 'parent', query.get('parent'), { min: 0 })
    return parent === undefined || (row.parent ?? 0) === parent
  })
export const getCategory = (ctx: RouteContext) =>
  getTerm(ctx, () => catalog(ctx).listCategories!(), (row) => serializeWcCategory(row, apiBase(ctx)))
export const listTags = (ctx: RouteContext) =>
  listTerms(ctx, () => catalog(ctx).listTags!(), (row) => serializeWcTag(row, apiBase(ctx)))
export const getTag = (ctx: RouteContext) =>
  getTerm(ctx, () => catalog(ctx).listTags!(), (row) => serializeWcTag(row, apiBase(ctx)))

export async function listAttributes(ctx: RouteContext): Promise<Response> {
  try {
    const rows = await catalog(ctx).listAttributes!()
    return jsonResponse(rows.map((row) => serializeWcAttribute(row, apiBase(ctx))))
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_attributes_error', errorMessage(err, 'Failed to list attributes.'), 500)
  }
}

export const getAttribute = (ctx: RouteContext) =>
  getTerm(
    ctx,
    async () => (await catalog(ctx).listAttributes!()).map((row) => ({ ...row, slug: row.slug ?? '' })),
    (row) => serializeWcAttribute(row, apiBase(ctx))
  )

async function attributeExists(ctx: RouteContext): Promise<boolean> {
  const attributes = catalog(ctx).listAttributes ? await catalog(ctx).listAttributes!() : []
  return attributes.some((row) => String(row.id) === ctx.params.attribute_id)
}

export async function listAttributeTerms(ctx: RouteContext): Promise<Response> {
  if (catalog(ctx).listAttributes && !(await attributeExists(ctx))) {
    return wcErrorResponse('woocommerce_rest_taxonomy_invalid', 'Resource does not exist.', 404)
  }
  const attributeId = Number(ctx.params.attribute_id)
  return listTerms(ctx, () => catalog(ctx).listAttributeTerms!(attributeId), (row) =>
    serializeWcAttributeTerm(row, attributeId, apiBase(ctx))
  )
}

export async function getAttributeTerm(ctx: RouteContext): Promise<Response> {
  const attributeId = Number(ctx.params.attribute_id)
  return getTerm(ctx, () => catalog(ctx).listAttributeTerms!(attributeId), (row) =>
    serializeWcAttributeTerm(row, attributeId, apiBase(ctx))
  )
}
