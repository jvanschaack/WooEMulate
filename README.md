# WooEMulate

> **Connect your custom store to tools that already support WooCommerce.**

WooEMulate is a lightweight TypeScript library that exposes WooCommerce-compatible API endpoints over your existing backend. It translates requests from external services into calls to your database adapter, so you can reuse compatible WooCommerce integrations without running WordPress, PHP, or WooCommerce.

Shipping and fulfillment are initial use cases. The broader purpose is to make WooCommerce's integration ecosystem accessible to custom, headless, and serverless stores.

[![npm version](https://img.shields.io/npm/v/wooemulate.svg)](https://www.npmjs.com/package/wooemulate)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)

## How it works

A service offers a "Connect WooCommerce" option, but your store uses a different backend. WooEMulate provides the API surface that a compatible connector expects:

```text
External service with a WooCommerce connector
                    |
          WooCommerce API requests
                    |
                WooEMulate
                    |
          Your database adapter
                    |
        Your existing store and data
```

You deploy the endpoints on your store's domain, configure credentials, and map your data into WooEmulate's order format. The external service reads supported data and sends supported updates through the same connection.

**Compatibility depends on the exact endpoints, authentication, and behavior the service requires.** A WooCommerce connection option is a starting point for integration, not a guarantee of support. This library currently implements a subset of the WooCommerce API, with an emphasis on orders.

## What you can build

| Use case | Current fit |
| --- | --- |
| Shipping and fulfillment | Order reads, status changes, and shipment-tracking callbacks for clients that use the implemented endpoints. |
| Order reporting and dashboards | Order data is available for clients that poll the orders API. |
| Order-based automation | Clients can poll orders and submit supported updates; outgoing webhooks are not implemented. |
| Accounting, CRM, inventory, and catalog integrations | Potential extensions. Verify required data and endpoints; customer management, products, stock updates, refunds, and detailed accounting behavior are not implemented. |

These are integration patterns, not a list of verified third-party services. See [integration compatibility](#integration-compatibility).

## Features and API coverage

- Zero runtime dependencies; TypeScript types are included.
- Standard Fetch API `Request` and `Response` objects for framework adapters.
- HTTP Basic authentication and `consumer_key` / `consumer_secret` query parameters.
- Order serialization, pagination headers, and adapter hooks for status and tracking updates.
- Stable numeric API IDs with an adapter lookup for stores using string IDs.
- Optional owner-approved connection authorization, disabled by default.

The router accepts `wc/v1`, `wc/v2`, and `wc/v3` paths for the same handlers. Those aliases do not imply full implementation of each API version. The table uses `wc/v3` paths.

| Endpoint | Supported behavior |
| --- | --- |
| `GET /wp-json` | API discovery. |
| `GET /wp-json/wc/v3` | Namespace discovery. |
| `GET /wp-json/wc/v3/system_status` | Emulated store diagnostics; reported WordPress/PHP/plugin values are compatibility placeholders. |
| `GET /wp-json/wc/v3/orders` | List orders. Filters, sorting, and pagination are delegated to your adapter. |
| `GET /wp-json/wc/v3/orders/:id` | Fetch an order by its numeric API ID. |
| `PUT / POST /wp-json/wc/v3/orders/:id` | Status and supported tracking-field updates through optional hooks. General order editing is not implemented. |
| `GET / POST /wp-json/wc/v3/orders/:id/shipment-trackings` | Read tracking or pass it to your adapter. Posting also marks the order completed when the status hook is present. |
| `GET / POST /wc-auth/v1/authorize` | Optional consent and credential callback flow requiring explicit configuration and authenticated owner approval. |

Order creation/deletion, order notes, products, inventory, customers, refunds, outgoing webhooks, WordPress plugin execution, and ShipStation-specific routes are not implemented. Configured API keys grant read/write access to implemented operations; per-key scopes are not enforced.

## Installation

```bash
npm install wooemulate
```

Use documentation matching the installed version. For the changes on this branch, build from this checkout with `npm ci` and `npm run build` until a release includes them.

## Quickstart

### 1. Implement your database adapter

Your database remains the source of truth. Import the adapter types from `wooemulate`; the complete contract is in [src/types.ts](src/types.ts).

| Adapter method | Responsibility |
| --- | --- |
| `listOrders(params)` | Apply filters and sorting; return one page and the count of all matching orders before pagination. |
| `getOrder(idOrNumber)` | Fetch by internal ID or order number. Used after updates, and for numeric API IDs when no dedicated lookup hook exists. |
| `getOrderByWooCommerceId(id)` | Resolve the persisted numeric API ID to the original record. Implement this for mapped string IDs. |
| `updateOrderStatus(orderId, status)` | Optional: persist a status change using the original internal order ID. |
| `onShipmentTrackingCreated(orderId, tracking)` | Optional: persist tracking and return its ID. Make repeated submissions safe for your storage model. |

For a runnable starting point, copy [examples/in-memory-adapter.ts](examples/in-memory-adapter.ts) into your app as `lib/store-adapter.ts` and rename its `demoAdapter` export to `storeAdapter`. It demonstrates filters, pagination, ID lookups, and both update hooks. Replace its in-memory operations with persistent database calls before using it for real orders.

Return objects matching `WooEmulateOrder`. For example:

```typescript
import type { WooEmulateOrder } from 'wooemulate'

const order: WooEmulateOrder = {
  id: 'ord_abc123',       // Your database's original ID
  wooCommerceId: 1001,   // A unique, persisted numeric API ID
  orderNumber: 'WEB-123', // Display number; does not determine the API ID
  status: 'processing',
  createdAt: '2026-09-27T12:00:00Z',
  totalCents: 2500,
  shippingAddress: {
    firstName: 'Alex',
    address1: '123 Example Street',
    city: 'Austin',
    state: 'TX',
    postalCode: '78701',
    country: 'US',
  },
  items: [{ name: 'Example product', quantity: 1, unitPriceCents: 2500 }],
}
```

### 2. Create the request handler

Save this as `lib/store-api.ts` (or `src/lib/store-api.ts`). Replace the store name and URL. Supply credentials through your framework's server-side environment or secret bindings.

```typescript
import {
  createWooEmulate,
  type WooEmulateAdapter,
  type WooEmulateAuthConfig,
} from 'wooemulate'

export function createStoreApi(auth: WooEmulateAuthConfig, adapter: WooEmulateAdapter) {
  if (!auth.consumerKey || !auth.consumerSecret) {
    throw new Error('WooCommerce API credentials are required')
  }

  const emulator = createWooEmulate({
    store: { name: 'My Store', url: 'https://store.example', currency: 'USD' },
    auth,
    adapter,
  })

  return (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname
    if (path === '/wp-json' || path.startsWith('/wp-json/')) {
      return emulator.handleRequest(request)
    }
    return Promise.resolve(new Response('Not Found', { status: 404 }))
  }
}
```

This exposes the order API and discovery routes. To mount the separate authorization route, follow [one-click authorization](#one-click-authorization).

### 3. Mount the handler

The `storeAdapter` imports below refer to your implementation from step 1.

**Next.js App Router:** create `app/wp-json/[[...slug]]/route.ts`. The [optional catch-all](https://nextjs.org/docs/app/api-reference/file-conventions/dynamic-routes#optional-catch-all-segments) includes the discovery root at `/wp-json`.

```typescript
import { createStoreApi } from '@/lib/store-api'
import { storeAdapter } from '@/lib/store-adapter'

const handle = createStoreApi({
  consumerKey: process.env.WC_CONSUMER_KEY!,
  consumerSecret: process.env.WC_CONSUMER_SECRET!,
}, storeAdapter)

export const GET = handle
export const POST = handle
export const PUT = handle
export const OPTIONS = handle
```

**Astro:** create `src/pages/wp-json/[...path].ts` and configure a [server adapter for on-demand endpoints](https://docs.astro.build/en/guides/endpoints/#server-endpoints-api-routes).

```typescript
import type { APIRoute } from 'astro'
import { createStoreApi } from '../../lib/store-api'
import { storeAdapter } from '../../lib/store-adapter'

export const prerender = false
const handle = createStoreApi({
  consumerKey: import.meta.env.WC_CONSUMER_KEY,
  consumerSecret: import.meta.env.WC_CONSUMER_SECRET,
}, storeAdapter)
export const ALL: APIRoute = ({ request }) => handle(request)
```

**Cloudflare Workers:** supply credentials through Worker secret bindings.

```typescript
import { createStoreApi } from './lib/store-api'
import { storeAdapter } from './lib/store-adapter'

interface Env {
  WC_CONSUMER_KEY: string
  WC_CONSUMER_SECRET: string
}

export default {
  fetch(request: Request, env: Env) {
    return createStoreApi({
      consumerKey: env.WC_CONSUMER_KEY,
      consumerSecret: env.WC_CONSUMER_SECRET,
    }, storeAdapter)(request)
  },
}
```

### 4. Connect a compatible service

1. Deploy your handler at a publicly reachable HTTPS store URL.
2. Compare the service's connector requirements with the API coverage above.
3. Select its WooCommerce connection and enter your store URL and API credentials if manual credentials are supported.
4. Verify discovery, authentication, order import, filters, pagination, and fetching an order by the ID returned in the list.
5. Verify each update the service sends and confirm it persists in your backend.

Services requiring an authorization redirect need the optional flow below. Unsupported routes, plugin behavior, or outgoing webhooks require additional implementation.

## Stable order IDs

API IDs must be integers from `1` through `2147483647`. If your internal `id` is already a number or canonical numeric string in that range, it can be used directly. For arbitrary string IDs, allocate and persist a unique `wooCommerceId` and implement `getOrderByWooCommerceId`.

Enforce uniqueness in your database, preserve the mapping across deployments, and never recycle an ID for another order. The library does not allocate or persist IDs for you. Display `orderNumber` values can change without changing API identity. Status and tracking hooks receive the original `order.id`.

## One-click authorization

`/wc-auth/v1/authorize` is disabled by default. Enabling it requires exact HTTPS callback and return URL allowlists plus an `oauth.authorize` hook that verifies the current store owner using your application's session system.

GET shows consent without releasing credentials. Approval requires a POST from the configured store origin and a successful owner check. Callback redirects are not followed, and failed callbacks do not report success.

Add the following option to your emulator configuration. `getStoreOwnerSession` represents your own trusted server-side session verifier; implement it before enabling this flow.

```typescript
oauth: {
  allowedCallbackUrls: ['https://service.example/woocommerce/callback'],
  allowedReturnUrls: ['https://service.example/woocommerce/connected'],
  async authorize(request, connection) {
    const owner = await getStoreOwnerSession(request)
    return owner?.canManageIntegrations === true
  },
},
```

Then mount `/wc-auth/v1/authorize` to that configured emulator as well as `/wp-json`. Use your real HTTPS `store.url`; the request origin and approval POST's `Origin` header must match it. Do not replace the session check with unconditional approval.

This flow shares configured credentials; it does not create a separate key per app. Only `read_write` scope is supported. Key rotation and per-service credential management belong to the host application.

## Integration compatibility

The repository includes local API tests. Those tests do not establish end-to-end compatibility with third-party services.

| Service or connector | Status and known gaps |
| --- | --- |
| Generic WooCommerce REST clients | Candidates when their required endpoints match this implementation; validate the complete workflow. |
| Pirate Ship | Unverified end to end. Its [documented integration](https://support.pirateship.com/en/articles/1515789-how-does-the-woocommerce-integration-work) writes tracking as order/customer notes. The order-notes API is absent, so the shipment-tracking endpoint alone does not establish compatibility. |
| ShipStation | Its [documented integration](https://help.shipstation.com/hc/en-us/articles/360026141671-WooCommerce) requires the ShipStation plugin and uses `/wp-json/wc-shipstation/*` routes. Those routes and plugin behavior are not implemented here. |

To contribute a verified integration, document the service and version/date tested, required endpoints, connection method, and successful import/update scenarios. Include sanitized request/response fixtures where possible.

## Limitations and migration notes

- **Previous automatic authorization:** public GET requests no longer dispatch credentials. Configure owner-approved authorization explicitly or use manual API keys where supported. Rotate credentials if an earlier unprotected authorization route was publicly exposed.
- **Previous generated IDs:** `getWcNumericId` now validates numeric IDs instead of stripping characters or hashing strings. Persist existing external IDs when unique and valid, add the reverse lookup, and resolve collisions before reconnecting clients. External order routes now use numeric API IDs.
- **Adapter writes:** omitted update hooks do not persist changes, even if the handler returns success. Implement the hooks your integration needs and verify storage updates.
- **Data fidelity:** monetary values use cents and two decimal places. Customer IDs, product IDs, taxes, refunds, payment dates, and other serialized fields may be placeholders or simplified values; validate them before using accounting or catalog workflows.
- **Package metadata:** weight is summed from item weights and quantities. Dimensions use the largest value on each axis, not a packing calculation; they do not account for multiple items or packaging.
- **Deployment:** mount at the expected root paths and use HTTPS. The existing `cors` configuration is not enforced by response handlers; configure origin policy at your application or proxy if needed.

## Development

```bash
npm ci
npm run build
npm run typecheck
npm test
```

Tests cover authentication, order access and updates, numeric identity, and guarded connection authorization. Third-party service testing is a separate step.

## License

[MIT](LICENSE) © 2026 WooEMulate Contributors.
