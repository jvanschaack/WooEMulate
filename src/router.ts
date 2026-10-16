/**
 * WooEMulate Router
 * Central request dispatcher matching incoming HTTP requests to WooCommerce emulation handlers.
 */

import { authenticateApi, checkKeyPermission, wcErrorResponse } from './auth.js'
import { assertTimeZone } from './dates.js'
import { handleDiscovery, handleNamespaceIndex } from './handlers/discovery.js'
import { handleOAuthAuthorize } from './handlers/oauth.js'
import { CORS_HEADERS, createInputReader, jsonResponse, type ApiVersion, type HttpMethod, type RouteContext } from './http.js'
import { ALL_NAMESPACES, WC_NAMESPACES, compileRoutes, type CompiledRoute, type RouteAction } from './routes.js'
import type { WooEmulateConfig, WooEmulateRequestContext, WooEmulateWebhookDelivery } from './types.js'
import { dispatchWebhooks } from './webhooks.js'

export interface WooEmulateInstance {
  handleRequest(request: Request, context?: WooEmulateRequestContext): Promise<Response>
  config: WooEmulateConfig
  webhooks: {
    /**
     * Delivers a topic to every active webhook subscribed to it and resolves with each attempt.
     * Pass the current resource object for resource topics (for `*.deleted`, the object or its
     * numeric API ID) and the hook argument for `action.*` topics. Resolves with [] when
     * webhooks are not configured. Hosts on serverless runtimes can pass the promise to
     * `waitUntil`.
     */
    dispatch(topic: string, resource: unknown): Promise<WooEmulateWebhookDelivery[]>
  }
}

const DENIED: Record<RouteAction, [string, string]> = {
  list: ['woocommerce_rest_cannot_view', 'Sorry, you cannot list resources.'],
  view: ['woocommerce_rest_cannot_view', 'Sorry, you cannot view this resource.'],
  create: ['woocommerce_rest_cannot_create', 'Sorry, you are not allowed to create resources.'],
  edit: ['woocommerce_rest_cannot_edit', 'Sorry, you are not allowed to edit this resource.'],
  delete: ['woocommerce_rest_cannot_delete', 'Sorry, you are not allowed to delete this resource.'],
  batch: ['woocommerce_rest_cannot_batch', 'Sorry, you are not allowed to batch manipulate this resource.'],
}

const METHODS = new Set<string>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const NAMESPACES_LONGEST_FIRST = [...ALL_NAMESPACES].sort((a, b) => b.length - a.length)

function noRoute(): Response {
  return wcErrorResponse('rest_no_route', 'No route was found matching the URL and request method.', 404)
}

function versionOf(namespace: string): ApiVersion {
  if (namespace === 'wc/v1') return 'v1'
  if (namespace === 'wc/v2') return 'v2'
  return 'v3'
}

export function createWooEmulate(config: WooEmulateConfig): WooEmulateInstance {
  if (!config.auth && !config.apiKeys) {
    throw new Error('WooEMulate requires API credentials: configure `auth`, `apiKeys`, or both.')
  }
  if (config.store.timezone) assertTimeZone(config.store.timezone)
  const routes = compileRoutes()

  async function authorizeRoute(
    request: Request,
    method: HttpMethod,
    action: RouteAction
  ): Promise<{ response: Response } | { key: RouteContext['key'] }> {
    const outcome = await authenticateApi(request, config)
    if (outcome.status === 'error') {
      return { response: wcErrorResponse(outcome.code, outcome.message, outcome.httpStatus, outcome.headers) }
    }
    if (outcome.status === 'anonymous') {
      const [code, message] = DENIED[action]
      return { response: wcErrorResponse(code, outcome.message || message, outcome.httpStatus || 401) }
    }
    const denied = checkKeyPermission(outcome.key, method)
    if (denied && denied.status === 'error') {
      return { response: wcErrorResponse(denied.code, denied.message, denied.httpStatus) }
    }
    return { key: outcome.key }
  }

  async function dispatchApi(
    request: Request,
    url: URL,
    method: HttpMethod,
    cleanPath: string,
    apiBase: string,
    home: string,
    context: WooEmulateRequestContext
  ): Promise<{ response: Response; route?: string }> {
    if (cleanPath === '' || cleanPath === '/wp-json') {
      return { response: method === 'GET' ? handleDiscovery(config, routes, apiBase, home) : noRoute(), route: '/' }
    }

    const rest = cleanPath.slice('/wp-json'.length)
    const namespace = NAMESPACES_LONGEST_FIRST.find((ns) => rest === `/${ns}` || rest.startsWith(`/${ns}/`))
    if (!namespace) return { response: noRoute() }
    const subPath = rest.slice(namespace.length + 1)
    if (subPath === '') {
      return {
        response: method === 'GET' ? handleNamespaceIndex(config, routes, apiBase, namespace) : noRoute(),
        route: `/${namespace}`,
      }
    }

    let matched: { route: CompiledRoute; params: Record<string, string> } | undefined
    for (const route of routes) {
      if (!route.namespaces.includes(namespace)) continue
      const match = subPath.match(route.pattern)
      if (match) {
        matched = { route, params: { ...match.groups } }
        break
      }
    }

    const spec = matched?.route.methods[method]
    const routeName = matched ? `/${namespace}${matched.route.path}` : undefined
    if (!spec || (spec.enabled && !spec.enabled(config))) {
      const emptyCollection =
        method === 'GET' &&
        (WC_NAMESPACES as readonly string[]).includes(namespace) &&
        config.emptyCollections?.includes(subPath.slice(1))
      if (!emptyCollection) return { response: noRoute(), route: routeName }
      const auth = await authorizeRoute(request, method, 'list')
      if ('response' in auth) return { response: auth.response, route: `/${namespace}${subPath}` }
      return {
        response: jsonResponse([], 200, { 'X-WP-Total': '0', 'X-WP-TotalPages': '0' }),
        route: `/${namespace}${subPath}`,
      }
    }

    const auth = await authorizeRoute(request, method, spec.action)
    if ('response' in auth) return { response: auth.response, route: routeName }

    const ctx: RouteContext = {
      config,
      request,
      method,
      url,
      namespace,
      version: versionOf(namespace),
      params: matched!.params,
      apiBase,
      key: auth.key,
      waitUntil: context.waitUntil,
      input: createInputReader(request, url),
    }
    try {
      return { response: await spec.handler(ctx), route: routeName }
    } catch {
      return {
        response: wcErrorResponse('woocommerce_rest_internal_error', 'An internal error occurred.', 500),
        route: routeName,
      }
    }
  }

  function observe(
    context: WooEmulateRequestContext,
    event: Parameters<NonNullable<WooEmulateConfig['onRequest']>>[0]
  ) {
    if (!config.onRequest) return
    try {
      const result = config.onRequest(event)
      if (result && typeof (result as Promise<void>).then === 'function') {
        const settled = Promise.resolve(result).catch(() => undefined)
        context.waitUntil?.(settled)
      }
    } catch {
      // Observers never affect the response.
    }
  }

  return {
    config,
    webhooks: {
      dispatch: (topic, resource) => dispatchWebhooks(config, topic, resource),
    },
    async handleRequest(request: Request, context: WooEmulateRequestContext = {}): Promise<Response> {
      const started = Date.now()

      // 1. Handle CORS Preflight OPTIONS
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS })
      }

      const url = new URL(request.url)
      const prefix = config.basePath && url.pathname.startsWith(config.basePath) ? config.basePath : ''
      let pathname = url.pathname.slice(prefix.length)
      if (!pathname.startsWith('/')) pathname = `/${pathname}`

      // Remove trailing slash for matching, except for exact root
      const cleanPath = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname

      // 2. OAuth 1-Click Handshake (/wc-auth/v1/authorize)
      if (cleanPath === '/wc-auth/v1/authorize') {
        const response = await handleOAuthAuthorize(config, request)
        observe(context, {
          method: request.method,
          path: cleanPath,
          queryParams: [...new Set(url.searchParams.keys())],
          status: response.status,
          route: '/wc-auth/v1/authorize',
          durationMs: Date.now() - started,
        })
        return response
      }

      // 3. Effective method: HEAD is served as GET; POST honors _method / X-HTTP-Method-Override.
      const original = request.method.toUpperCase()
      let method = (original === 'HEAD' ? 'GET' : original) as HttpMethod
      if (original === 'POST') {
        const override = (url.searchParams.get('_method') || request.headers.get('x-http-method-override') || '').toUpperCase()
        if (METHODS.has(override)) method = override as HttpMethod
      }

      const isApi = cleanPath === '' || cleanPath === '/wp-json' || cleanPath.startsWith('/wp-json/')
      const home = `${url.origin}${prefix}`
      const apiBase = `${home}/wp-json`
      const { response, route } =
        isApi && METHODS.has(method)
          ? await dispatchApi(request, url, method, cleanPath, apiBase, home, context)
          : { response: noRoute(), route: undefined }

      // 4. Every REST response advertises the API root, as WordPress does.
      const headers = new Headers(response.headers)
      const apiLink = `<${apiBase}/>; rel="https://api.w.org/"`
      const existingLink = headers.get('Link')
      headers.set('Link', existingLink ? `${apiLink}, ${existingLink}` : apiLink)
      const finalResponse = new Response(original === 'HEAD' ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })

      observe(context, {
        method,
        path: cleanPath,
        queryParams: [...new Set(url.searchParams.keys())],
        status: finalResponse.status,
        route,
        durationMs: Date.now() - started,
      })
      return finalResponse
    },
  }
}
