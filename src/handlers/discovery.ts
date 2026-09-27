/**
 * WooEMulate Discovery Handler
 * Advertises WordPress REST API and WooCommerce v1/v2/v3 namespaces at /wp-json.
 */

import type { WooEmulateConfig } from '../types.js'

export function handleDiscovery(config: WooEmulateConfig, url: URL): Response {
  const origin = url.origin || config.store.url

  const discoveryPayload = {
    name: config.store.name,
    description: config.store.description || `${config.store.name} REST API`,
    url: origin,
    home: origin,
    namespaces: ['wc/v1', 'wc/v2', 'wc/v3'],
    authentication: {
      oauth1: false,
      application_passwords: false,
      basic_auth: true,
    },
    routes: {
      '/': {
        namespace: '',
        methods: ['GET'],
        endpoints: [{ methods: ['GET'], args: {} }],
        _links: { self: [{ href: `${origin}/wp-json/` }] },
      },
      '/wc/v1': {
        namespace: 'wc/v1',
        methods: ['GET'],
        endpoints: [{ methods: ['GET'], args: {} }],
        _links: { self: [{ href: `${origin}/wp-json/wc/v1` }] },
      },
      '/wc/v2': {
        namespace: 'wc/v2',
        methods: ['GET'],
        endpoints: [{ methods: ['GET'], args: {} }],
        _links: { self: [{ href: `${origin}/wp-json/wc/v2` }] },
      },
      '/wc/v3': {
        namespace: 'wc/v3',
        methods: ['GET'],
        endpoints: [{ methods: ['GET'], args: {} }],
        _links: { self: [{ href: `${origin}/wp-json/wc/v3` }] },
      },
      '/wc/v3/system_status': {
        namespace: 'wc/v3',
        methods: ['GET'],
        endpoints: [{ methods: ['GET'], args: {} }],
        _links: { self: [{ href: `${origin}/wp-json/wc/v3/system_status` }] },
      },
      '/wc/v3/orders': {
        namespace: 'wc/v3',
        methods: ['GET'],
        endpoints: [
          {
            methods: ['GET'],
            args: {
              status: { required: false },
              per_page: { required: false },
              page: { required: false },
            },
          },
        ],
        _links: { self: [{ href: `${origin}/wp-json/wc/v3/orders` }] },
      },
      '/wc/v3/orders/(?P<id>[\\d]+)': {
        namespace: 'wc/v3',
        methods: ['GET', 'POST', 'PUT'],
        endpoints: [
          { methods: ['GET'], args: {} },
          { methods: ['PUT'], args: {} },
          { methods: ['POST'], args: {} },
        ],
        _links: { self: [{ href: `${origin}/wp-json/wc/v3/orders` }] },
      },
    },
    _links: {
      help: [{ href: 'https://woo.com/document/woocommerce-rest-api/' }],
    },
  }

  return new Response(JSON.stringify(discoveryPayload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-WP-Nonce',
    },
  })
}
