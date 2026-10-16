/**
 * WooEMulate HTTP helpers
 * Shared response, parameter, and pagination behavior matching the WordPress REST API.
 */

import { parseDateParam } from './dates.js'
import type { WooEmulateConfig } from './types.js'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type ApiVersion = 'v1' | 'v2' | 'v3'

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'OPTIONS, GET, POST, PUT, PATCH, DELETE',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-WP-Nonce, X-HTTP-Method-Override',
  'Access-Control-Expose-Headers': 'X-WP-Total, X-WP-TotalPages, Link',
}

/** Query parameters that carry credentials or transport details and never count as API input. */
const TRANSPORT_PARAMS = new Set(['consumer_key', 'consumer_secret', '_method', '_envelope', '_jsonp'])

export function isTransportParam(name: string): boolean {
  return TRANSPORT_PARAMS.has(name) || name.startsWith('oauth_')
}

export function jsonResponse(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...headers },
  })
}

export interface RouteContext {
  config: WooEmulateConfig
  request: Request
  /** Effective method after HEAD and method-override handling. */
  method: HttpMethod
  url: URL
  namespace: string
  version: ApiVersion
  params: Record<string, string>
  /** Absolute URL of the `/wp-json` root, including any configured basePath. */
  apiBase: string
  /** Authenticated API key, when the route requires authentication. */
  key?: { keyId: number; permissions: string; userId?: string | number }
  waitUntil?(promise: Promise<unknown>): void
  /** Request parameters: query string merged with the form or JSON body (body wins). */
  input(): Promise<Record<string, any>>
}

export function routeUrl(ctx: RouteContext, path: string): string {
  return `${ctx.apiBase}/${ctx.namespace}${path}`
}

export function selfLinks(ctx: RouteContext, itemPath: string, collectionPath: string) {
  return {
    self: [{ href: routeUrl(ctx, itemPath) }],
    collection: [{ href: routeUrl(ctx, collectionPath) }],
  }
}

/** Reads the request body once and merges it over the query parameters. */
export function createInputReader(request: Request, url: URL): () => Promise<Record<string, any>> {
  let cached: Promise<Record<string, any>> | undefined
  return () => {
    cached ??= (async () => {
      const merged: Record<string, any> = {}
      for (const [key, value] of url.searchParams) {
        if (!isTransportParam(key)) merged[key] = value
      }
      if (request.method === 'GET' || request.method === 'HEAD') return merged
      const text = await request.text().catch(() => '')
      if (!text.trim()) return merged
      const type = request.headers.get('content-type') || ''
      if (type.includes('application/x-www-form-urlencoded')) {
        for (const [key, value] of new URLSearchParams(text)) merged[key] = value
        return merged
      }
      try {
        const body = JSON.parse(text)
        if (body && typeof body === 'object' && !Array.isArray(body)) Object.assign(merged, body)
      } catch {
        // WordPress ignores unparseable bodies and keeps the query parameters.
      }
      return merged
    })()
    return cached
  }
}

export class ParamErrors {
  readonly errors: Record<string, string> = {}
  add(name: string, message: string) {
    this.errors[name] = message
  }
  get any(): boolean {
    return Object.keys(this.errors).length > 0
  }
  response(): Response {
    const names = Object.keys(this.errors)
    return jsonResponse(
      {
        code: 'rest_invalid_param',
        message: `Invalid parameter(s): ${names.join(', ')}`,
        data: { status: 400, params: this.errors },
      },
      400
    )
  }
}

export function parseInteger(
  errors: ParamErrors,
  name: string,
  raw: unknown,
  { min, max }: { min?: number; max?: number } = {}
): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const value = typeof raw === 'number' ? raw : /^-?\d+$/.test(String(raw).trim()) ? Number(raw) : NaN
  if (!Number.isInteger(value)) {
    errors.add(name, `${name} is not of type integer.`)
    return undefined
  }
  if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
    const range = [min !== undefined ? `${min} (inclusive)` : '', max !== undefined ? `${max} (inclusive)` : '']
    errors.add(
      name,
      min !== undefined && max !== undefined
        ? `${name} must be between ${range[0]} and ${range[1]}`
        : min !== undefined
          ? `${name} must be greater than or equal to ${min}`
          : `${name} must be less than or equal to ${max}`
    )
    return undefined
  }
  return value
}

export function parseBoolean(errors: ParamErrors, name: string, raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'boolean') return raw
  const text = String(raw).toLowerCase()
  if (text === 'true' || text === '1') return true
  if (text === 'false' || text === '0' || text === '') return false
  errors.add(name, `${name} is not of type boolean.`)
  return undefined
}

export function parseEnum<T extends string>(
  errors: ParamErrors,
  name: string,
  raw: unknown,
  allowed: readonly T[]
): T | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const value = String(raw)
  if (!allowed.includes(value as T)) {
    errors.add(name, `${name} is not one of ${allowed.join(', ')}.`)
    return undefined
  }
  return value as T
}

/** Reads `name=a,b` and `name[]=a&name[]=b` forms from the query string. */
export function readList(url: URL, name: string): string[] | undefined {
  const values = [...url.searchParams.getAll(name), ...url.searchParams.getAll(`${name}[]`)]
  if (values.length === 0) return undefined
  return values.flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean)
}

export function parseIdList(errors: ParamErrors, url: URL, name: string): number[] | undefined {
  const values = readList(url, name)
  if (!values) return undefined
  const ids: number[] = []
  values.forEach((value, index) => {
    const id = /^\d+$/.test(value) ? Number(value) : NaN
    if (!Number.isSafeInteger(id)) errors.add(name, `${name}[${index}] is not of type integer.`)
    else ids.push(id)
  })
  return ids
}

export interface ListParams<O extends string> {
  page: number
  perPage: number
  offset: number
  order: 'asc' | 'desc'
  orderby: O
  search?: string
  include?: number[]
  exclude?: number[]
  after?: string
  before?: string
  modifiedAfter?: string
  modifiedBefore?: string
}

export interface ListOptions<O extends string> {
  orderby: readonly O[]
  defaultOrderby: O
  defaultOrder?: 'asc' | 'desc'
  /** Supports after/before (and modified_* when `modified` is true). */
  dates?: boolean
  modified?: boolean
}

/** Parses the collection parameters shared by WooCommerce list endpoints. */
export function parseListParams<O extends string>(
  ctx: RouteContext,
  errors: ParamErrors,
  options: ListOptions<O>
): ListParams<O> {
  const query = ctx.url.searchParams
  const timeZone = ctx.config.store.timezone || 'UTC'
  const perPage = parseInteger(errors, 'per_page', query.get('per_page'), { min: 1, max: 100 }) ?? 10
  const page = parseInteger(errors, 'page', query.get('page'), { min: 1 }) ?? 1
  const explicitOffset = parseInteger(errors, 'offset', query.get('offset'), { min: 0 })
  const order =
    parseEnum(errors, 'order', query.get('order')?.toLowerCase(), ['asc', 'desc'] as const) ??
    options.defaultOrder ??
    'desc'
  const orderby =
    parseEnum(errors, 'orderby', query.get('orderby')?.toLowerCase(), options.orderby) ??
    options.defaultOrderby
  const params: ListParams<O> = {
    page: explicitOffset !== undefined ? Math.floor(explicitOffset / perPage) + 1 : page,
    perPage,
    offset: explicitOffset ?? (page - 1) * perPage,
    order,
    orderby,
  }
  const search = query.get('search')
  if (search) params.search = search
  params.include = parseIdList(errors, ctx.url, 'include')
  params.exclude = parseIdList(errors, ctx.url, 'exclude')
  if (options.dates) {
    const datesAreGmt = parseBoolean(errors, 'dates_are_gmt', query.get('dates_are_gmt')) ?? false
    const names = options.modified
      ? (['after', 'before', 'modified_after', 'modified_before'] as const)
      : (['after', 'before'] as const)
    for (const name of names) {
      const raw = query.get(name)
      if (!raw) continue
      const date = parseDateParam(raw, datesAreGmt, timeZone)
      if (!date) {
        errors.add(name, 'Invalid date.')
        continue
      }
      const iso = date.toISOString()
      if (name === 'after') params.after = iso
      else if (name === 'before') params.before = iso
      else if (name === 'modified_after') params.modifiedAfter = iso
      else params.modifiedBefore = iso
    }
  }
  if (!params.include) delete params.include
  if (!params.exclude) delete params.exclude
  return params
}

/** Builds `X-WP-Total`, `X-WP-TotalPages`, and `Link` prev/next headers for a collection. */
export function paginationHeaders(
  ctx: RouteContext,
  { page, perPage, total, totalPages }: { page: number; perPage: number; total: number; totalPages?: number }
): Record<string, string> {
  const maxPages = totalPages ?? Math.ceil(total / perPage)
  const base = new URL(ctx.url.href)
  for (const name of [...base.searchParams.keys()]) {
    if (isTransportParam(name)) base.searchParams.delete(name)
  }
  const link = (rel: string, target: number) => {
    const url = new URL(base.href)
    url.searchParams.set('page', String(target))
    return `<${url.href}>; rel="${rel}"`
  }
  const links: string[] = []
  if (page > 1) links.push(link('prev', Math.max(1, Math.min(page - 1, maxPages))))
  if (maxPages > page) links.push(link('next', page + 1))
  const headers: Record<string, string> = {
    'X-WP-Total': String(total),
    'X-WP-TotalPages': String(maxPages),
  }
  if (links.length) headers.Link = links.join(', ')
  return headers
}

/** Applies search, include/exclude, sorting, and paging to a fully loaded collection. */
export function paginateInMemory<T>(
  items: T[],
  params: ListParams<string>,
  fields: { id(item: T): number; search?(item: T): string[]; sort?(item: T, orderby: string): string | number }
): { items: T[]; total: number } {
  let rows = items
  if (params.include) rows = rows.filter((item) => params.include!.includes(fields.id(item)))
  if (params.exclude) rows = rows.filter((item) => !params.exclude!.includes(fields.id(item)))
  if (params.search && fields.search) {
    const needle = params.search.toLowerCase()
    rows = rows.filter((item) => fields.search!(item).some((value) => value.toLowerCase().includes(needle)))
  }
  const sortKey = (item: T): string | number =>
    params.orderby === 'include' && params.include
      ? params.include.indexOf(fields.id(item))
      : params.orderby === 'id' || !fields.sort
        ? fields.id(item)
        : fields.sort(item, params.orderby)
  rows = [...rows].sort((a, b) => {
    const left = sortKey(a)
    const right = sortKey(b)
    const comparison =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right))
    const ordered = comparison || fields.id(a) - fields.id(b)
    return params.order === 'asc' ? ordered : -ordered
  })
  return { items: rows.slice(params.offset, params.offset + params.perPage), total: rows.length }
}

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}
