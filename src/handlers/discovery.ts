/**
 * WooEMulate Discovery Handler
 * Builds the `/wp-json` index and namespace indexes from the enabled route table.
 */

import { zoneOffsetMs } from '../dates.js'
import { jsonResponse } from '../http.js'
import { ALL_NAMESPACES, enabledMethods, type CompiledRoute } from '../routes.js'
import type { WooEmulateConfig } from '../types.js'

type RouteIndex = Record<string, Record<string, unknown>>

function routeEntries(
  config: WooEmulateConfig,
  routes: CompiledRoute[],
  apiBase: string,
  namespace: string
): RouteIndex {
  const entries: RouteIndex = {
    [`/${namespace}`]: {
      namespace,
      methods: ['GET'],
      endpoints: [{ methods: ['GET'], args: { namespace: { default: namespace, required: false } } }],
      _links: { self: [{ href: `${apiBase}/${namespace}` }] },
    },
  }
  for (const route of routes) {
    if (!route.namespaces.includes(namespace)) continue
    const methods = enabledMethods(route, config)
    if (methods.length === 0) continue
    // Group methods that share a handler, as WordPress lists one endpoint per callback.
    const groups = new Map<unknown, string[]>()
    for (const method of methods) {
      const handler = route.methods[method]!.handler
      groups.set(handler, [...(groups.get(handler) || []), method])
    }
    const path = `/${namespace}${route.path}`
    entries[path] = {
      namespace,
      methods,
      endpoints: [...groups.values()].map((group) => ({ methods: group, args: {} })),
      ...(route.path.includes('(?P<') ? {} : { _links: { self: [{ href: `${apiBase}${path}` }] } }),
    }
  }
  return entries
}

function activeNamespaces(config: WooEmulateConfig, routes: CompiledRoute[]): string[] {
  return ALL_NAMESPACES.filter((namespace) =>
    routes.some((route) => route.namespaces.includes(namespace) && enabledMethods(route, config).length > 0)
  )
}

export function handleDiscovery(config: WooEmulateConfig, routes: CompiledRoute[], apiBase: string, home: string): Response {
  const timeZone = config.store.timezone || 'UTC'
  const namespaces = activeNamespaces(config, routes)
  let indexRoutes: RouteIndex = {
    '/': {
      namespace: '',
      methods: ['GET'],
      endpoints: [{ methods: ['GET'], args: { context: { default: 'view', required: false } } }],
      _links: { self: [{ href: `${apiBase}/` }] },
    },
  }
  for (const namespace of namespaces) {
    indexRoutes = { ...indexRoutes, ...routeEntries(config, routes, apiBase, namespace) }
  }

  return jsonResponse({
    name: config.store.name,
    description: config.store.description || `${config.store.name} REST API`,
    url: home,
    home,
    gmt_offset: String(zoneOffsetMs(new Date(), timeZone) / 3_600_000),
    timezone_string: timeZone === 'UTC' ? '' : timeZone,
    namespaces,
    authentication: [],
    routes: indexRoutes,
    _links: {
      help: [{ href: 'https://developer.wordpress.org/rest-api/' }],
    },
  })
}

export function handleNamespaceIndex(
  config: WooEmulateConfig,
  routes: CompiledRoute[],
  apiBase: string,
  namespace: string
): Response {
  return jsonResponse({
    namespace,
    routes: routeEntries(config, routes, apiBase, namespace),
    _links: { up: [{ href: `${apiBase}/` }] },
  })
}
