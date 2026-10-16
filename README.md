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

You deploy the endpoints on your store's domain, configure credentials, and map your data into WooEMulate's formats. The external service reads supported data and sends supported updates through the same connection.

**Compatibility depends on the exact endpoints, authentication, and behavior the service requires.** A WooCommerce connection option is a starting point for integration, not a guarantee of support. WooEMulate implements the parts of the WooCommerce REST API most integrations use: orders, notes, refunds, products and stock, customers, coupons, webhooks, reports, and settings. Plugin-specific APIs and catalog creation are not implemented.

## What you can build

| Use case | Current fit |
| --- | --- |
| Shipping and fulfillment | Order import, status updates, tracking through order notes or the Shipment Tracking routes, product weights and SKUs. |
| Automation and ETL | Paginated and incremental order syncs (`Link` headers, `offset`, `modified_after`), plus webhooks for instant triggers. |
| Inventory and order management | Product and variation reads with stock and price updates. Product creation is not supported. |
| Helpdesk and CRM | Order, customer, and note lookups. |
| Accounting and reporting | Tax, fee, coupon, shipping, and refund lines; sales and top-seller reports computed from your orders. |

These are integration patterns, not a list of verified third-party services. See [integration compatibility](#integration-compatibility) and the [integration research](docs/integration-research.md).

## Features and API coverage

- Zero runtime dependencies; TypeScript types are included.
- Standard Fetch API `Request` and `Response` objects for framework adapters.
- Authentication with HTTP Basic or `consumer_key` / `consumer_secret` query parameters, checked in WooCommerce's order (query string first). Opt-in one-legged OAuth 1.0a for plain-HTTP clients.
- One static key, or a key store with `read`, `write`, and `read_write` permissions enforced per method.
- WooCommerce protocol details: `X-WP-Total`, `X-WP-TotalPages`, and `Link` headers; `per_page` (default 10, max 100), `offset`, `include`, `exclude`, `modified_after`, and `dates_are_gmt`; WooCommerce date formats in the store time zone; `PATCH`, `HEAD`, and method overrides; WooCommerce error codes.
- v1, v2, and v3 namespaces, with version-specific order and note shapes.
- Discovery generated from the routes your adapter enables.
- Stable numeric API IDs with adapter lookups for stores using string IDs.

Each optional adapter section or hook enables its routes; routes without one return `rest_no_route`. The table uses `wc/v3` paths. `wc/v1` and `wc/v2` serve the same routes.

| Endpoint | Methods | Enabled by |
| --- | --- | --- |
| `/wp-json`, `/wp-json/wc/v1`–`v3` | GET | Always. Public discovery and namespace indexes. |
| `/system_status`, `/system_status/tools` | GET | Always. Reported WordPress, PHP, and plugin values are compatibility placeholders. |
| `/orders`, `/orders/:id` | GET; POST/PUT/PATCH on an order | Always. Updates accept status and tracking fields; status writes need `updateOrderStatus`. |
| `/orders/:id/notes`, `/orders/:id/notes/:note_id` | GET, POST, DELETE | `listOrderNotes`, `createOrderNote`, `deleteOrderNote` |
| `/orders/:id/refunds`, `/orders/:id/refunds/:refund_id` | GET, POST | `listOrderRefunds`, `createOrderRefund` |
| `/orders/:id/shipment-trackings` (also `/:tracking_id`, `/providers`) | GET, POST | Always. Also served under `wc-shipment-tracking/v3` and `wc-ast/v3`. |
| `/products`, `/products/:id`, `/products/batch` | GET; PUT/PATCH for stock and price | `products.listProducts`, `getProduct`, `updateProduct` |
| `/products/:id/variations` (also `/:variation_id`, `/batch`) | GET; PUT/PATCH for stock and price | `products.listVariations`, `getVariation`, `updateVariation` |
| `/products/categories`, `/tags`, `/attributes`, `/attributes/:id/terms` | GET | `products.listCategories`, `listTags`, `listAttributes`, `listAttributeTerms` |
| `/customers`, `/customers/:id` | GET | `customers` section |
| `/coupons`, `/coupons/:id` | GET | `coupons` section |
| `/webhooks`, `/webhooks/:id`, `/webhooks/batch` | GET, POST, PUT/PATCH, DELETE | `webhooks.store` |
| `/reports`, `/reports/sales`, `/reports/top_sellers`, `/reports/orders/totals` | GET | Always. Computed from your orders. |
| `/reports/products/totals`, `/reports/customers/totals` | GET | `products.listProducts`, `reports.customersTotals` |
| `/settings`, `/settings/general`, `/settings/products` | GET | Always. Values come from your store configuration. |
| `/wc-auth/v1/authorize` | GET, POST | The `oauth` option. Requires owner approval. |

Not implemented:
- Creating or deleting orders, products, customers, or coupons.
- Editing order fields other than status and tracking, or product fields other than stock and price.
- Customer and coupon writes.
- Payment gateway, shipping zone, tax, and data endpoints.
- The legacy `/wc-api` API, plugin-specific namespaces (for example ShipStation, Zapier, or Klaviyo), and the Store API.
- WordPress logins and application passwords.

## Installation

```bash
npm install wooemulate
```

Use documentation matching the installed version. This README describes `main`, which includes roadmap phases 0–4 (see the [changelog](CHANGELOG.md)). Until a release includes them, build from a checkout with `npm ci` and `npm run build`.

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

`listOrders` receives `offset`, which takes priority over `page`, plus `include`, `exclude`, `modifiedAfter`, `modifiedBefore`, `customer`, and `product` filters. Date filters arrive as UTC ISO strings. Optional sections for notes, products, customers, coupons, refunds, and reports are described in [optional adapter sections](#optional-adapter-sections).

For a runnable starting point, copy [examples/in-memory-adapter.ts](examples/in-memory-adapter.ts) into your app as `lib/store-adapter.ts` and rename its `demoAdapter` export to `storeAdapter`. It demonstrates filters, offset pagination, ID lookups, both update hooks, and order notes. Replace its in-memory operations with persistent database calls before using it for real orders.

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
export const HEAD = handle
export const POST = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
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

Services that require an authorization redirect need the [one-click authorization](#one-click-authorization) flow. Services that register webhooks need the [webhook store](#webhooks). To see exactly which endpoints a service calls, use the [request observer](#diagnostics-and-connection-checks).

## Stable order IDs

API IDs must be integers from `1` through `2147483647`. If your internal `id` is already a number or canonical numeric string in that range, it can be used directly. For arbitrary string IDs, allocate and persist a unique `wooCommerceId` and implement `getOrderByWooCommerceId`.

Enforce uniqueness in your database, preserve the mapping across deployments, and never recycle an ID for another order. The library does not allocate or persist IDs for you. Display `orderNumber` values can change without changing API identity. Status and tracking hooks receive the original `order.id`.

The same rules apply to products, variations, customers, and coupons. Their `get*` hooks receive the numeric API ID. Order line items reference products through `productId` and `variationId` API IDs.

## Optional adapter sections

Each section or hook is optional and enables only its routes. The types are in [src/types.ts](src/types.ts).

| Section or hook | Enables | Notes |
| --- | --- | --- |
| `listOrderNotes`, `createOrderNote`, `deleteOrderNote` | Order notes | Many shipping services write tracking as notes. With `trackingFromNotes: true`, tracking found by `parseTrackingFromNote` is passed to `onShipmentTrackingCreated`. A `customerNote` would be emailed to the customer by WooCommerce; your app decides whether to send one. |
| `listOrderRefunds`, `createOrderRefund` | Refunds | Creation validates amounts and line items first, including quantities already refunded by earlier refunds. `refundPayment` (`api_refund`) and `restockItems` (`api_restock`) tell your app whether to return money and restock. |
| `products` | Products, variations, taxonomies | `listProducts` and `getProduct` are required in the section. `updateProduct` and `updateVariation` receive only stock and price changes; any other changed field is rejected. Weights are in pounds and dimensions in inches. |
| `customers` | Customers | `listCustomers` and `getCustomer`. |
| `coupons` | Coupons | `listCoupons` and `getCoupon`. |
| `reports.customersTotals` | `/reports/customers/totals` | Paying and non-paying customer counts. |

For accurate accounting data, populate the order's `taxLines`, `shippingLines`, `feeLines`, `couponLines`, `refunds`, `customerId`, `paidAt`, and line-item `productId`, `variationId`, and `taxes`. Omitted values follow WooCommerce defaults:
- `product_id` is 0 when unknown.
- `date_paid` is set for processing and completed orders only.
- One shipping line is synthesized from `shippingCents`.

## Webhooks

Configure a persistent webhook store to enable the `/webhooks` API. Services such as n8n, Pipedream, Make, Metorik, and Printify register webhooks through it. Then dispatch topics when your data changes:

```typescript
const emulator = createWooEmulate({
  store, auth, adapter,
  webhooks: { store: webhookStore }, // implements WooEmulateWebhookStore
})

// After an order changes in your app:
await emulator.webhooks.dispatch('order.updated', order)
// Cloudflare Workers: ctx.waitUntil(emulator.webhooks.dispatch('order.updated', order))
```

Deliveries match WooCommerce:
- **Payload:** the resource serialized at the webhook's API version. `*.deleted` topics send `{ id }`, and `action.*` topics send `{ action, arg }`.
- **Headers:** `X-WC-Webhook-Source`, `Topic`, `Resource`, `Event`, `ID`, `Delivery-ID`, and `Signature`, a base64 HMAC-SHA256 of the raw body.
- **Ping:** creating or reactivating a webhook sends an unsigned `webhook_id=<id>` ping. Pass `handleRequest(request, { waitUntil })` to run it in the background.
- **Failures:** responses from 200 to 302 count as success. Repeated failures disable the webhook after `maxDeliveryFailures`, which defaults to 5.

[examples/in-memory-stores.ts](examples/in-memory-stores.ts) shows the webhook store, API key store, and OAuth 1.0a nonce store contracts. Back each one with your database in production.

Delivery URLs must use HTTPS and cannot point at localhost, private, link-local, or internal hosts. This is checked when a webhook is created and again at each delivery. The check cannot detect public hostnames that resolve to private addresses. Use `validateDeliveryUrl` to replace the policy, for example with an allowlist, or to allow `http://localhost` during local testing.

## API keys and permissions

The `auth` option accepts one key pair, with optional `permissions` and `keyId`. For several keys, configure `apiKeys` with a `WooEmulateApiKeyStore`; it is checked before `auth`.

Each key carries `read`, `write`, or `read_write`:
- `GET` and `HEAD` require read permission.
- `POST`, `PUT`, `PATCH`, and `DELETE` require write permission.
- Failures return WooCommerce's `woocommerce_rest_authentication_error`.

Secrets are compared in constant time.

Clients that use a plain-HTTP store URL sign requests with OAuth 1.0a, including WooCommerce's official JavaScript, PHP, and Python clients. To accept them, configure `oauth1: { useNonce }`. The hook must record each nonce and reject reuse within 15 minutes. Production stores should use HTTPS.

Repeated parameters are handled strictly, so that the values your handlers read are always the signed ones:
- A request that repeats any `oauth_*` parameter is rejected.
- Other repeated parameters, such as `status[]=processing&status[]=completed`, verify when the client signed every occurrence.
- WooCommerce's official JavaScript client sends each query parameter twice but signs it once. That form is accepted only when both copies carry the same value.

## One-click authorization

`/wc-auth/v1/authorize` is disabled by default. Enabling it requires:
- exact allowlists for the callback URL, which must be HTTPS, and the return URL;
- an `oauth.authorize` hook that verifies the current store owner using your application's session system.

GET shows consent without releasing credentials. Approval requires a POST from the configured store origin and a successful owner check. As in WooCommerce:
- All five parameters (`app_name`, `scope`, `user_id`, `return_url`, `callback_url`) are required.
- The callback must answer exactly HTTP 200.
- The owner is redirected to `return_url` with `success` and `user_id`.

Callback redirects are not followed, and failed callbacks never report success.

Add the following option to your emulator configuration. `getStoreOwnerSession` represents your own trusted server-side session verifier; implement it before enabling this flow.

```typescript
oauth: {
  allowedCallbackUrls: ['https://service.example/woocommerce/callback'],
  allowedReturnUrls: ['https://service.example/woocommerce/connected'],
  async authorize(request, connection) {
    const owner = await getStoreOwnerSession(request)
    return owner?.canManageIntegrations === true
  },
  // Optional: send signed-out owners to your login page instead of returning 403.
  loginUrl: (returnTo) => `/login?next=${encodeURIComponent(returnTo)}`,
},
```

Then mount `/wc-auth/v1/authorize` to that configured emulator as well as `/wp-json`. Use your real HTTPS `store.url`; the request origin and the approval POST's `Origin` header must match it. Do not replace the session check with unconditional approval.

Credentials depend on what is configured:
- **Key store with `apiKeys.createApiKey`:** each approved app receives its own `ck_`/`cs_` key with the requested scope (`read`, `write`, or `read_write`) and its real `key_id`. If the callback fails, the key is deleted with `deleteApiKey`.
- **Without a key store:** the single configured key is shared, and only a scope matching its `permissions` is accepted.

When testing a service, record its callback and return URLs so you can add them to the allowlists.

## Dates and time zones

Responses use WooCommerce's `YYYY-MM-DDTHH:MM:SS` format:
- Plain `date_*` fields are in `store.timezone`, an IANA name that defaults to UTC.
- `*_gmt` fields are in UTC.

Adapter dates may be `Date` objects or ISO strings. Strings without an offset are read as UTC.

Date filters without an offset are interpreted in the store time zone, or in UTC with `dates_are_gmt=true`. They reach your adapter as UTC ISO strings.

## Diagnostics and connection checks

- `onRequest(event)` reports each request's method, path, query parameter names (never values), status, matched route, and duration. Use it to record which endpoints a service calls.
- `emptyCollections: ['products/categories']` returns an empty list for listed read-only routes your adapter does not implement. Some services call those routes as connection checks; the list is empty by default.
- `/system_status/tools` and `/reports/orders/totals` exist because Airbyte and Linnworks use them as connection checks.

## Integration compatibility

The repository's test suite runs these real clients against the emulator:

| Client | Result |
| --- | --- |
| [`@woocommerce/woocommerce-rest-api`](https://github.com/woocommerce/woocommerce-rest-api-js-lib) 1.0.2 (official JavaScript client) | Passes order list, read, and update; shipment tracking; and product stock updates. It was tested over HTTP with OAuth 1.0a, and over HTTPS with Basic auth and with query-string credentials (`tests/official-client.mjs`). |

Checked manually against [`scripts/dev-server.mjs`](scripts/dev-server.mjs) in October 2026. The steps are in [docs/verification.md](docs/verification.md).

| Client | Result |
| --- | --- |
| [n8n](https://github.com/n8n-io/n8n) 2.35.7, WooCommerce node | Get Many with Return All collected all 250 orders by following `Link` headers. Get and Update (status) worked with Basic auth and with "Include Credentials in Query". |
| n8n 2.35.7, WooCommerce Trigger | On activation, listed and created its webhook. A dispatched `order.updated` delivery passed n8n's HMAC signature check and started a successful execution. |
| [Airbyte `source-woocommerce`](https://github.com/airbytehq/airbyte/tree/master/airbyte-integrations/connectors/source-woocommerce) manifest 5.11.1 | The connection check passed. An incremental orders sync returned all 250 orders exactly once, using 30-day `modified_after`/`modified_before` windows with `offset` paging. A second run from the saved state returned no records. Run with `airbyte-cdk` over HTTPS. |
| [singer-io `tap-woocommerce`](https://github.com/singer-io/tap-woocommerce) 0.1.2 | Synced 250 orders over three `wc/v2` pages and wrote its incremental bookmark. Its pinned `requests` must be upgraded to run on Python 3.13. |

Hosted services have not been verified end to end:

| Service or connector | Status and known gaps |
| --- | --- |
| Pirate Ship | Unverified. Its [documented integration](https://support.pirateship.com/en/articles/1515789-how-does-the-woocommerce-integration-work) writes tracking as order notes; implement the notes hooks and consider `trackingFromNotes`. It likely reads item weights from products. |
| Starshipit, Extensiv Integration Manager | Unverified. Both offer a Shipment Tracking write-back mode that uses the implemented routes. |
| ShipStation | Requires the ShipStation plugin and `/wp-json/wc-shipstation/*` routes, which are not implemented. |
| Zapier | Requires a paid WordPress plugin and its private `wc-zapier/v1` routes, which are not implemented. n8n, Make, and Pipedream use the standard REST API and webhooks. |

The [integration research](docs/integration-research.md) surveys about 140 services. The [roadmap](docs/roadmap.md) tracks open decisions.

To contribute a verified integration, document:
- the service and the version or date tested;
- the required endpoints;
- the connection method;
- the import and update scenarios that succeeded.

Include sanitized request/response fixtures where possible.

## Limitations and migration notes

**Upgrading from 0.1.0.** These changes align the emulator with WooCommerce and alter observable behavior (see the [changelog](CHANGELOG.md)):

- **Paging:** `per_page` defaults to 10. Values outside 1–100, and invalid `page`, `orderby`, or `order` values, return 400 `rest_invalid_param` instead of being clamped.
- **Date format:** dates are formatted `YYYY-MM-DDTHH:MM:SS`, with plain fields in `store.timezone` (UTC by default).
- **`date_paid` and `date_completed`:** `date_paid` is `null` for unpaid statuses unless `paidAt` is set, and `date_completed` is set only for completed orders.
- **`product_id`:** line-item `product_id` comes from `productId` and is 0 when unknown. It is no longer synthesized.
- **Shipping address:** the shipping address no longer has an `email` field.
- **Names:** a provided `lastName` is no longer re-split from `firstName`.
- **Status updates:** invalid order statuses return 400 instead of being coerced to `processing`.
- **Unsupported methods:** these return 404 `rest_no_route`, not 405.
- **Invalid order IDs:** these return `woocommerce_rest_shop_order_invalid_id`.
- **Authentication:** query-string credentials are checked before Basic auth.
- **One-click authorization:** a callback must answer exactly 200.
- **Error responses:** unknown keys return WooCommerce's "cannot view/edit" errors, and invalid secrets return `woocommerce_rest_authentication_error`.
- **API versions:** `wc/v1` and `wc/v2` return their own order schemas.

Earlier migration notes:

- **Previous automatic authorization:** public GET requests no longer dispatch credentials. Configure owner-approved authorization explicitly or use manual API keys where supported. Rotate credentials if an earlier unprotected authorization route was publicly exposed.
- **Previous generated IDs:** `getWcNumericId` now validates numeric IDs instead of stripping characters or hashing strings. Persist existing external IDs when unique and valid, add the reverse lookup, and resolve collisions before reconnecting clients. External order routes now use numeric API IDs.

Limitations:

- **Adapter writes:** order status and shipment-tracking updates return success even when their hooks are omitted, and nothing is persisted. Newer write routes (notes, refunds, stock, and webhooks) exist only when their hooks do.
- **Paging:** `listOrders` should honor `offset`. Adapters that only use `page` still work when `offset` is a multiple of `per_page`.
- **Reports:**
  - Sales and top-seller reports page through matching orders and return an error past 5000 orders.
  - `total_customers` counts distinct buyers in the range.
  - Refunds count against the order's date.
- **Package metadata:** weight is summed from item weights and quantities. Dimensions use the largest value on each axis, not a packing calculation; they do not account for multiple items or packaging.
- **Deployment:** mount at the expected root paths and use HTTPS. The `cors` option is not enforced by response handlers; responses allow any origin without credentials. Configure origin policy at your application or proxy if needed.

## Development

```bash
npm ci
npm run build
npm run typecheck
npm test
```

The test suite covers:
- protocol conformance, including n8n's `Link` paging loop and Airbyte-style offset paging;
- authentication, permissions, and OAuth 1.0a;
- notes, order fidelity, and API version shapes;
- webhooks, including n8n's signature verification;
- products, customers, coupons, refunds, reports, and settings;
- one-click authorization;
- the official WooCommerce JavaScript client over HTTP and HTTPS.

## License

[MIT](LICENSE) © 2026 WooEMulate Contributors.
