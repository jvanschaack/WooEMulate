/**
 * WooEMulate Route Table
 * WordPress-style route definitions. Discovery output is generated from this table, so it only
 * advertises routes and methods that are actually enabled for the configured adapter.
 */

import { getOrder, listOrders, updateOrder } from './handlers/orders.js'
import { ordersTotalsReport } from './handlers/reports.js'
import {
  createShipmentTracking,
  getShipmentTracking,
  listShipmentTrackingProviders,
  listShipmentTrackings,
} from './handlers/shipment-tracking.js'
import { handleSystemStatus, handleSystemStatusTools } from './handlers/system-status.js'
import type { HttpMethod, RouteContext } from './http.js'
import type { WooEmulateConfig } from './types.js'

export type RouteAction = 'list' | 'view' | 'create' | 'edit' | 'delete' | 'batch'

export interface MethodSpec {
  handler(ctx: RouteContext): Promise<Response> | Response
  /** Determines the WooCommerce "cannot …" error returned to unauthenticated clients. */
  action: RouteAction
  /** The route method exists only when this returns true (for example, an adapter hook is present). */
  enabled?(config: WooEmulateConfig): boolean
}

export interface RouteSpec {
  /** Path relative to the namespace, using WordPress `(?P<name>…)` groups. */
  path: string
  namespaces?: readonly string[]
  methods: Partial<Record<HttpMethod, MethodSpec>>
}

export interface CompiledRoute extends RouteSpec {
  pattern: RegExp
  namespaces: readonly string[]
}

export const WC_NAMESPACES = ['wc/v1', 'wc/v2', 'wc/v3'] as const
export const TRACKING_NAMESPACES = [...WC_NAMESPACES, 'wc-shipment-tracking/v3', 'wc-ast/v3'] as const
export const ALL_NAMESPACES = [...TRACKING_NAMESPACES]

const ID = '(?P<id>[\\d]+)'
const ORDER = '/orders/(?P<order_id>[\\d]+)'

/** POST, PUT, and PATCH all edit an existing item, as in WordPress (`WP_REST_Server::EDITABLE`). */
export function editable(spec: MethodSpec): Partial<Record<HttpMethod, MethodSpec>> {
  return { POST: spec, PUT: spec, PATCH: spec }
}

const ROUTES: RouteSpec[] = [
  { path: '/system_status', methods: { GET: { handler: handleSystemStatus, action: 'view' } } },
  { path: '/system_status/tools', methods: { GET: { handler: handleSystemStatusTools, action: 'list' } } },

  { path: '/orders', methods: { GET: { handler: listOrders, action: 'list' } } },
  {
    path: `/orders/${ID}`,
    methods: { GET: { handler: getOrder, action: 'view' }, ...editable({ handler: updateOrder, action: 'edit' }) },
  },

  {
    path: `${ORDER}/shipment-trackings`,
    namespaces: TRACKING_NAMESPACES,
    methods: {
      GET: { handler: listShipmentTrackings, action: 'list' },
      POST: { handler: createShipmentTracking, action: 'create' },
    },
  },
  {
    path: `${ORDER}/shipment-trackings/providers`,
    namespaces: TRACKING_NAMESPACES,
    methods: { GET: { handler: listShipmentTrackingProviders, action: 'list' } },
  },
  {
    path: `${ORDER}/shipment-trackings/(?P<id>[\\w-]+)`,
    namespaces: TRACKING_NAMESPACES,
    methods: { GET: { handler: getShipmentTracking, action: 'view' } },
  },

  { path: '/reports/orders/totals', methods: { GET: { handler: ordersTotalsReport, action: 'list' } } },
]

export function compileRoutes(routes: RouteSpec[] = ROUTES): CompiledRoute[] {
  return routes.map((route) => ({
    ...route,
    namespaces: route.namespaces ?? WC_NAMESPACES,
    pattern: new RegExp('^' + route.path.replace(/\(\?P</g, '(?<') + '$'),
  }))
}

export function enabledMethods(route: RouteSpec, config: WooEmulateConfig): HttpMethod[] {
  return (Object.keys(route.methods) as HttpMethod[]).filter((method) => {
    const spec = route.methods[method]
    return spec && (!spec.enabled || spec.enabled(config))
  })
}
