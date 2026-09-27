/**
 * WooEMulate Router
 * Central request dispatcher matching incoming HTTP requests to WooCommerce emulation handlers.
 */

import { wcErrorResponse } from './auth.js'
import { handleDiscovery } from './handlers/discovery.js'
import { handleOAuthAuthorize } from './handlers/oauth.js'
import { handleOrders } from './handlers/orders.js'
import { handleShipmentTracking } from './handlers/shipment-tracking.js'
import { handleSystemStatus } from './handlers/system-status.js'
import type { WooEmulateConfig } from './types.js'

export interface WooEmulateInstance {
  handleRequest(request: Request): Promise<Response>
  config: WooEmulateConfig
}

export function createWooEmulate(config: WooEmulateConfig): WooEmulateInstance {
  return {
    config,
    async handleRequest(request: Request): Promise<Response> {
      // 1. Handle CORS Preflight OPTIONS
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-WP-Nonce',
            'Access-Control-Expose-Headers': 'X-WP-Total, X-WP-TotalPages',
          },
        })
      }

      const url = new URL(request.url)
      let pathname = url.pathname

      // Strip configured basePath if present
      if (config.basePath && pathname.startsWith(config.basePath)) {
        pathname = pathname.slice(config.basePath.length)
        if (!pathname.startsWith('/')) pathname = `/${pathname}`
      }

      // Remove trailing slash for matching, except for exact root
      const cleanPath = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname

      // 2. Discovery Root (/wp-json)
      if (cleanPath === '/wp-json' || cleanPath === '') {
        return handleDiscovery(config, url)
      }

      // 3. OAuth 1-Click Handshake (/wc-auth/v1/authorize)
      if (cleanPath === '/wc-auth/v1/authorize') {
        return handleOAuthAuthorize(config, request)
      }

      // 4. System Status (/wp-json/wc/v3/system_status or v1, v2)
      if (/^\/wp-json\/wc\/v[1-3]\/system_status$/.test(cleanPath)) {
        return handleSystemStatus(config, request)
      }

      // 5. Shipment Trackings (/wp-json/wc/v[1-3]/orders/:id/shipment-trackings)
      const trackingMatch = cleanPath.match(/^\/wp-json\/wc\/v[1-3]\/orders\/([^/]+)\/shipment-trackings(?:\/.*)?$/)
      if (trackingMatch) {
        const orderId = decodeURIComponent(trackingMatch[1])
        return handleShipmentTracking(config, request, orderId)
      }

      // 6. Single Order (/wp-json/wc/v[1-3]/orders/:id)
      const singleOrderMatch = cleanPath.match(/^\/wp-json\/wc\/v[1-3]\/orders\/([^/]+)$/)
      if (singleOrderMatch) {
        const orderId = decodeURIComponent(singleOrderMatch[1])
        return handleOrders(config, request, orderId)
      }

      // 7. Orders Collection (/wp-json/wc/v[1-3]/orders)
      if (/^\/wp-json\/wc\/v[1-3]\/orders$/.test(cleanPath)) {
        return handleOrders(config, request)
      }

      // 8. Namespace Index (/wp-json/wc/v1, v2, v3)
      if (/^\/wp-json\/wc\/v[1-3]$/.test(cleanPath)) {
        return new Response(
          JSON.stringify({
            namespace: cleanPath.replace('/wp-json/', ''),
            routes: {
              [`${cleanPath}/orders`]: {
                endpoints: [{ methods: ['GET'] }],
              },
              [`${cleanPath}/system_status`]: {
                endpoints: [{ methods: ['GET'] }],
              },
            },
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Access-Control-Allow-Origin': '*',
            },
          }
        )
      }

      // Not Found
      return wcErrorResponse(
        'rest_no_route',
        'No route was found matching the URL and request method.',
        404
      )
    },
  }
}
