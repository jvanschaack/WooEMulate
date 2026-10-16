# Changelog

## Unreleased

This release implements phases 0–4 of the [roadmap](docs/roadmap.md). Several changes align observable behavior with WooCommerce; see "Changed" before upgrading.

### Added

- **Protocol conformance:**
  - `Link` header on every REST response, with `rel="prev"`/`rel="next"` on collections.
  - `offset`, `include`, `exclude`, `status[]` arrays, `modified_after`, `modified_before`, `dates_are_gmt`, `customer`, `product`, `parent`, and `dp` list parameters.
  - `PATCH`, `HEAD`, and `_method` / `X-HTTP-Method-Override`.
  - `store.timezone`.
  - Discovery generated from the enabled routes.
  - `/system_status/tools` and `/reports/orders/totals`.
  - Shipment Tracking routes also served under `wc-shipment-tracking/v3` and `wc-ast/v3`, with single-tracking and `providers` routes.
  - The `onRequest` observer and `emptyCollections`.
- **Order notes:**
  - `/orders/:id/notes` routes through `listOrderNotes`, `createOrderNote`, and `deleteOrderNote`.
  - `parseTrackingFromNote` and the opt-in `trackingFromNotes`.
- **Order data:**
  - Tax, shipping, fee, coupon, and refund lines.
  - `productId` and `variationId` on line items.
  - `customerId`, `paidAt`, `completedAt`, `parentId`, `orderKey`, `createdVia`, and `paymentUrl`.
  - v1 and v2 order shapes.
- **Webhooks:**
  - The `/webhooks` CRUD and batch API backed by `webhooks.store`.
  - `emulator.webhooks.dispatch(topic, resource)` with WooCommerce headers and HMAC-SHA256 signatures.
  - Pings, failure counting with auto-disable, and a delivery URL policy (`validateDeliveryUrl` to override).
  - `handleRequest(request, { waitUntil })`.
- **Products:**
  - Products, variations, categories, tags, attributes, and terms through `adapter.products`.
  - Stock and price updates (`updateProduct` and `updateVariation`) with batch support.
- **Customers and coupons:** customers (`adapter.customers`) and coupons (`adapter.coupons`), read-only.
- **Refunds:** `listOrderRefunds`, plus opt-in `createOrderRefund` with amount and line-item validation.
- **Reports:**
  - `/reports`, `/reports/sales`, and `/reports/top_sellers`, computed from orders.
  - `/reports/products/totals`, and `/reports/customers/totals` through `reports.customersTotals`.
- **Settings:**
  - `/settings`, `/settings/general`, and `/settings/products`.
  - New store options: `address`, `currencyPosition`, `thousandSeparator`, `decimalSeparator`, `decimals`, and `calcTaxes`.
- **API keys:**
  - `apiKeys` key store with `read`, `write`, and `read_write` permissions enforced per method.
  - `permissions` and `keyId` on the static `auth` key.
- **One-click authorization:**
  - `read` and `write` scopes.
  - With `apiKeys.createApiKey`, each app gets its own minted key, which is deleted if the callback fails.
  - The `oauth.loginUrl` and `oauth.callbackTimeoutMs` options.
- **OAuth 1.0a:** opt-in one-legged OAuth 1.0a (`oauth1.useNonce`) for plain-HTTP clients.
- **Exports:** product, customer, coupon, refund, and note serializers; `isSafeDeliveryUrl`, `isValidWebhookTopic`, `signWebhookPayload`, `timingSafeEqual`, and `currencySymbol`.

### Changed

- `per_page` defaults to 10 (was 50). Out-of-range `per_page`/`page` and invalid `orderby`/`order` return 400 `rest_invalid_param` instead of being clamped or cast.
- `X-WP-TotalPages` is 0 for empty collections.
- Dates are formatted `YYYY-MM-DDTHH:MM:SS` with no milliseconds or offset. Plain fields use `store.timezone` (default UTC) and `*_gmt` fields use UTC.
- `date_paid` is `null` for unpaid orders unless `paidAt` is set. `date_completed` is set only for completed orders.
- Line-item `product_id` comes from `productId` and is 0 when unknown. It was previously synthesized from the item ID or index.
- The shipping address no longer includes `email`. A provided `lastName` is no longer re-split from `firstName`.
- Invalid order statuses in updates return 400 instead of being coerced to `processing`.
- Unregistered methods return 404 `rest_no_route` (was 405).
- Error codes:
  - Invalid order IDs return `woocommerce_rest_shop_order_invalid_id`.
  - Unknown keys return the route's "cannot view/edit" error.
  - An invalid secret returns `woocommerce_rest_authentication_error`, with `WWW-Authenticate` when sent through Basic auth.
- Query-string credentials are checked before Basic auth, and secrets are compared in constant time.
- `/wc-auth/v1/authorize` changes:
  - All five parameters are required.
  - The callback must answer exactly HTTP 200 (previously any 2xx).
  - The timeout defaults to 30 seconds.
  - An allowlisted HTTP `return_url` is accepted.
- Discovery reports `authentication: []` and lists every enabled route.
- `auth` is optional when `apiKeys` is configured. `createWooEmulate` throws when neither is set.
