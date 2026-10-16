/**
 * WooEMulate Route Table
 * WordPress-style route definitions. Discovery output is generated from this table, so it only
 * advertises routes and methods that are actually enabled for the configured adapter.
 */

import { createOrderNote, deleteOrderNote, getOrderNote, listOrderNotes } from './handlers/notes.js'
import { getOrder, listOrders, updateOrder } from './handlers/orders.js'
import {
  batchProducts,
  batchVariations,
  getAttribute,
  getAttributeTerm,
  getCategory,
  getProduct,
  getTag,
  getVariation,
  listAttributeTerms,
  listAttributes,
  listCategories,
  listProducts,
  listTags,
  listVariations,
  updateProduct,
  updateVariation,
} from './handlers/products.js'
import {
  customersTotalsReport,
  listReports,
  ordersTotalsReport,
  productsTotalsReport,
  salesReport,
  topSellersReport,
} from './handlers/reports.js'
import { createRefund, getRefund, listRefunds } from './handlers/refunds.js'
import { getSetting, listSettingGroups, listSettings } from './handlers/settings.js'
import { getCoupon, getCustomer, listCoupons, listCustomers } from './handlers/customers.js'
import {
  createShipmentTracking,
  getShipmentTracking,
  listShipmentTrackingProviders,
  listShipmentTrackings,
} from './handlers/shipment-tracking.js'
import { handleSystemStatus, handleSystemStatusTools } from './handlers/system-status.js'
import { batchWebhooks, createWebhook, deleteWebhook, getWebhook, listWebhooks, updateWebhook } from './handlers/webhooks.js'
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

const hasWebhooks = (config: WooEmulateConfig) => Boolean(config.webhooks?.store)
type ProductHook = keyof NonNullable<WooEmulateConfig['adapter']['products']>
const products = (hook: ProductHook) => (config: WooEmulateConfig) => Boolean(config.adapter.products?.[hook])
const PRODUCT = '/products/(?P<product_id>[\\d]+)'

const ROUTES: RouteSpec[] = [
  { path: '/system_status', methods: { GET: { handler: handleSystemStatus, action: 'view' } } },
  { path: '/system_status/tools', methods: { GET: { handler: handleSystemStatusTools, action: 'list' } } },

  { path: '/orders', methods: { GET: { handler: listOrders, action: 'list' } } },
  {
    path: `/orders/${ID}`,
    methods: { GET: { handler: getOrder, action: 'view' }, ...editable({ handler: updateOrder, action: 'edit' }) },
  },

  {
    path: `${ORDER}/notes`,
    methods: {
      GET: { handler: listOrderNotes, action: 'list', enabled: (c) => !!c.adapter.listOrderNotes },
      POST: { handler: createOrderNote, action: 'create', enabled: (c) => !!c.adapter.createOrderNote },
    },
  },
  {
    path: `${ORDER}/notes/${ID}`,
    methods: {
      GET: { handler: getOrderNote, action: 'view', enabled: (c) => !!c.adapter.listOrderNotes },
      DELETE: { handler: deleteOrderNote, action: 'delete', enabled: (c) => !!c.adapter.deleteOrderNote },
    },
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

  {
    path: `${ORDER}/refunds`,
    methods: {
      GET: { handler: listRefunds, action: 'list', enabled: (c) => !!c.adapter.listOrderRefunds },
      POST: { handler: createRefund, action: 'create', enabled: (c) => !!c.adapter.createOrderRefund },
    },
  },
  {
    path: `${ORDER}/refunds/${ID}`,
    methods: { GET: { handler: getRefund, action: 'view', enabled: (c) => !!c.adapter.listOrderRefunds } },
  },

  { path: '/customers', methods: { GET: { handler: listCustomers, action: 'list', enabled: (c) => !!c.adapter.customers } } },
  { path: `/customers/${ID}`, methods: { GET: { handler: getCustomer, action: 'view', enabled: (c) => !!c.adapter.customers } } },
  { path: '/coupons', methods: { GET: { handler: listCoupons, action: 'list', enabled: (c) => !!c.adapter.coupons } } },
  { path: `/coupons/${ID}`, methods: { GET: { handler: getCoupon, action: 'view', enabled: (c) => !!c.adapter.coupons } } },

  { path: '/reports', methods: { GET: { handler: listReports, action: 'list' } } },
  { path: '/reports/sales', methods: { GET: { handler: salesReport, action: 'list' } } },
  { path: '/reports/top_sellers', methods: { GET: { handler: topSellersReport, action: 'list' } } },
  { path: '/reports/orders/totals', methods: { GET: { handler: ordersTotalsReport, action: 'list' } } },
  {
    path: '/reports/products/totals',
    methods: { GET: { handler: productsTotalsReport, action: 'list', enabled: products('listProducts') } },
  },
  {
    path: '/reports/customers/totals',
    methods: {
      GET: { handler: customersTotalsReport, action: 'list', enabled: (c) => !!c.adapter.reports?.customersTotals },
    },
  },

  { path: '/settings', methods: { GET: { handler: listSettingGroups, action: 'list' } } },
  { path: '/settings/(?P<group_id>[\\w-]+)', methods: { GET: { handler: listSettings, action: 'list' } } },
  { path: '/settings/(?P<group_id>[\\w-]+)/(?P<id>[\\w-]+)', methods: { GET: { handler: getSetting, action: 'view' } } },

  { path: '/products', methods: { GET: { handler: listProducts, action: 'list', enabled: products('listProducts') } } },
  { path: '/products/batch', methods: editable({ handler: batchProducts, action: 'batch', enabled: products('updateProduct') }) },
  {
    path: '/products/categories',
    methods: { GET: { handler: listCategories, action: 'list', enabled: products('listCategories') } },
  },
  {
    path: `/products/categories/${ID}`,
    methods: { GET: { handler: getCategory, action: 'view', enabled: products('listCategories') } },
  },
  { path: '/products/tags', methods: { GET: { handler: listTags, action: 'list', enabled: products('listTags') } } },
  { path: `/products/tags/${ID}`, methods: { GET: { handler: getTag, action: 'view', enabled: products('listTags') } } },
  {
    path: '/products/attributes',
    methods: { GET: { handler: listAttributes, action: 'list', enabled: products('listAttributes') } },
  },
  {
    path: `/products/attributes/${ID}`,
    methods: { GET: { handler: getAttribute, action: 'view', enabled: products('listAttributes') } },
  },
  {
    path: '/products/attributes/(?P<attribute_id>[\\d]+)/terms',
    methods: { GET: { handler: listAttributeTerms, action: 'list', enabled: products('listAttributeTerms') } },
  },
  {
    path: `/products/attributes/(?P<attribute_id>[\\d]+)/terms/${ID}`,
    methods: { GET: { handler: getAttributeTerm, action: 'view', enabled: products('listAttributeTerms') } },
  },
  {
    path: `/products/${ID}`,
    methods: {
      GET: { handler: getProduct, action: 'view', enabled: products('getProduct') },
      ...editable({ handler: updateProduct, action: 'edit', enabled: products('updateProduct') }),
    },
  },
  {
    path: `${PRODUCT}/variations`,
    methods: { GET: { handler: listVariations, action: 'list', enabled: products('listVariations') } },
  },
  {
    path: `${PRODUCT}/variations/batch`,
    methods: editable({ handler: batchVariations, action: 'batch', enabled: products('updateVariation') }),
  },
  {
    path: `${PRODUCT}/variations/${ID}`,
    methods: {
      GET: { handler: getVariation, action: 'view', enabled: products('getVariation') },
      ...editable({ handler: updateVariation, action: 'edit', enabled: products('updateVariation') }),
    },
  },

  {
    path: '/webhooks',
    methods: {
      GET: { handler: listWebhooks, action: 'list', enabled: hasWebhooks },
      POST: { handler: createWebhook, action: 'create', enabled: hasWebhooks },
    },
  },
  { path: '/webhooks/batch', methods: editable({ handler: batchWebhooks, action: 'batch', enabled: hasWebhooks }) },
  {
    path: `/webhooks/${ID}`,
    methods: {
      GET: { handler: getWebhook, action: 'view', enabled: hasWebhooks },
      ...editable({ handler: updateWebhook, action: 'edit', enabled: hasWebhooks }),
      DELETE: { handler: deleteWebhook, action: 'delete', enabled: hasWebhooks },
    },
  },
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
