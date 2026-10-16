# Roadmap

This roadmap turns the [integration research](integration-research.md) into phased work. Each phase lists what it adds, the services it should unlock once verified end to end, and its exit criteria.

## Status

Phases 0–4 are implemented on this branch; see the [changelog](../CHANGELOG.md). Open decisions 5 and 6 were resolved as recommended. Decisions 1–4 still need a maintainer's call.

| Phase | Implemented | Exit criteria |
| --- | --- | --- |
| 0: Protocol conformance | Yes | **Met:**<ul><li>The official JavaScript client runs in CI over HTTP (OAuth 1.0a) and HTTPS (Basic and query-string credentials).</li><li>Singer `tap-woocommerce` synced 250 orders.</li><li>n8n 2.35.7 ran Get Many (Return All), Get, and Update.</li></ul>**Not run:** Airbyte. It hard-codes HTTPS and needs its Python CDK. Its offset and `modified_after` paging is covered by tests. |
| 1: Notes and order fidelity | Yes | **Pending:** Pirate Ship and ShippingEasy/Shippo tests. They need a public HTTPS deployment. |
| 2: Webhooks | Yes | **Met:** an n8n 2.35.7 WooCommerce Trigger created its webhook and accepted a signed `order.updated` delivery. |
| 3: Products and stock | Yes | **Pending:** Channable import and a stock-sync round trip. They need a hosted store. |
| 4: Customers, refunds, coupons, reports, keys | Yes | **Covered by tests:** per-key permissions, per-app one-click keys, and OAuth 1.0a against an independent signer. **Pending:** hosted-service tests. |

[docs/verification.md](verification.md) describes how the manual checks were run.

## Principles

- **Match WooCommerce's behavior, not only its JSON shapes.** Clients depend on headers, defaults, date formats, and error codes as much as on fields.
- **Keep the adapter as the source of truth.** Each new resource is an optional adapter section. When the adapter omits a section, its routes stay unregistered (`rest_no_route`); they do not return invented data. Placeholder values in the serializer should shrink, not grow.
- **Make writes explicit.** Changes to money, stock, or the catalog need a dedicated adapter hook. When the hook is missing, new write endpoints return an error. They do not report success without persisting anything.
- **Verify before claiming support.** A service joins the README compatibility table only after a recorded end-to-end test.
- **Stay runtime-neutral.** Keep zero runtime dependencies and the Fetch API `Request`/`Response` interface. Background work such as webhook delivery accepts a host-provided `waitUntil` or queue, so it runs on Workers, Node, Deno, and Bun.

## Phases

### Phase 0: Protocol conformance

This phase adds no new resources. It fixes behavior that breaks real clients today.

| Change | Where | Why |
| --- | --- | --- |
| Send a `Link` header with `rel="next"` and `rel="prev"` built from the request URL, plus `rel="https://api.w.org/"`. Add `Link` to `Access-Control-Expose-Headers`. | `src/handlers/orders.ts`, `src/router.ts` | n8n's "Return All" throws without it. Mixed Analytics pages through results with it. |
| Default `per_page` to 10. Return 400 `rest_invalid_param` for values outside 1–100. Report `X-WP-TotalPages: 0` for empty results. | `src/handlers/orders.ts` | Matches WooCommerce. WooEMulate currently defaults to 50 and clamps. |
| Pass `offset`, `include`, `exclude`, array-style `status`, validated `orderby` (`date`, `id`, `include`, `title`, `slug`, `modified`), `parent`, `customer`, `product`, and `dp` to the adapter. | `src/types.ts` (`WooEmulateListOrdersParams`), `src/handlers/orders.ts` | Airbyte pages with `offset`. Sync clients filter by ID and modification date. |
| Support `modified_after`, `modified_before`, and `dates_are_gmt`. | Same files | Needed for incremental sync by Airbyte, the hotglue tap, and Metorik. |
| Format dates as WooCommerce does: `YYYY-MM-DDTHH:MM:SS` with no milliseconds or `Z`. Plain `date_*` fields use the store's time zone (new `store.timezone`); `*_gmt` fields use UTC. `date_paid` is `null` when unpaid (new optional `paidAt`). | `src/serializer.ts`, `src/helpers.ts` | Airbyte parses `%Y-%m-%dT%H:%M:%S`. Adapter strings currently pass through unchanged. |
| Accept `PATCH` on `/orders/:id`, serve `HEAD` as `GET`, and honor `_method` and `X-HTTP-Method-Override`. Unknown methods return 404 `rest_no_route`. Add `PATCH` to the CORS allowed methods. | `src/router.ts`, `src/handlers/orders.ts` | Matches WordPress core. Some clients and proxies send method overrides. |
| Check query-string credentials before Basic auth, compare secrets in constant time, and return WooCommerce's error codes and messages, including `WWW-Authenticate` for an invalid secret. | `src/auth.ts` | Fidelity and timing safety. |
| In `/wc-auth`, allow an allowlisted `http` return URL, require all five parameters, and treat only HTTP 200 as a successful callback. Keep redirect-following disabled and document that divergence. | `src/handlers/oauth.ts` | Matches WooCommerce except where the stricter behavior is safer. |
| Alias the shipment-tracking routes under `wc-shipment-tracking/v3` and `wc-ast/v3`. | `src/router.ts` | Supports tools configured for Advanced Shipment Tracking, such as Apliiq and Ordoro's AST option. |
| Add `GET /reports/orders/totals`, computed from adapter counts per status. | New handler | Linnworks calls it as its connection test, and the counts are real data. |
| Add `GET /system_status/tools`, returning `[]`. | `src/handlers/system-status.ts` | Airbyte's connection check calls it. |
| Add an `onRequest` observer that reports method, path, query parameter names, and response status, never credentials. | `src/router.ts`, `src/types.ts` | Testers can record exactly which endpoints a real service calls. |

**Exit criteria:**
- CI runs these clients against the example adapter:
  - the official `@woocommerce/woocommerce-rest-api` client, in both Basic and query-string modes;
  - singer-io `tap-woocommerce`;
  - an n8n workflow that chains Get Many (Return All), Get, and Update.
- An Airbyte incremental sync of the orders stream returns each order once.

**Expected to unlock:**
- n8n order nodes with Return All
- Airbyte's orders stream
- Mixed Analytics pagination
- Linnworks' connection test
- tools configured for AST

**Compatibility note:** the `per_page` default, out-of-range rejection, and date formatting all change observable behavior. That is acceptable while the version is 0.x, provided the changelog states it.

### Phase 1: Order notes and order fidelity

**Notes:**
- **Routes:**
  - `GET /orders/:id/notes`, filtered by `type=any|customer|internal`
  - `POST /orders/:id/notes`, returning 201 with `Location`
  - `GET /orders/:id/notes/:note_id`
  - `DELETE /orders/:id/notes/:note_id`, which requires `force=true`
  - Each returns the matching v1, v2, or v3 response shape.
- **Adapter:**
  - `listOrderNotes(orderId, { type })`
  - `createOrderNote(orderId, { note, customerNote, addedByUser })`, which returns `{ id, createdAt }`
  - an optional `deleteOrderNote`
- **Helper:** add `parseTrackingFromNote(text)`, a best-effort extractor for carrier, tracking number, and URL. Services such as Pirate Ship, Shippo, ShippingEasy, and Printify write tracking as free-text notes, so adapters need a way to store it as structured tracking. The helper is opt-in, not automatic.
- **Customer emails:** document that a note with `customer_note: true` means WooCommerce would email the customer. The host decides whether to send that email.

**Order fidelity** (serializer changes and `WooEmulateOrder` additions):
- **Line items:**
  - real `product_id` and `variation_id` from new `productId` and `variationId` fields
  - line-item `meta_data`, `image`, and `parent_name`
- **Totals and lines:**
  - `tax_lines` and per-line `taxes`
  - `fee_lines` and `coupon_lines`
  - `shipping_lines` taken from order data instead of one synthesized flat rate
- **Dates and IDs:**
  - `customer_id`, `date_paid`, and `date_completed` taken from data
  - a summary of `refunds`
- **Address fields:** remove the non-standard `shipping.email`, which WooCommerce's shipping address does not have.
- **Version shapes:** add v1 and v2 serializers. v1 has no `*_gmt` dates and no order-level `meta_data`; v2 adds both.

**Exit criteria:**
- A recorded Pirate Ship test covering import, label purchase, the tracking note, and the Completed status.
- A second test with ShippingEasy or Shippo.

**Expected to unlock:**
- Shipping: Pirate Ship (weights may still need Phase 3), Shippo, ShippingEasy, AfterShip Shipping, Ship&co, Starshipit in note mode, Extensiv's default confirmation method
- Fulfillment write-back: CustomCat, and tracking from Printful and Printify
- Helpdesks: notes for Re:amaze and Zoho Desk
- Accounting tools gain accurate order data. Refunds arrive in Phase 4.

### Phase 2: Webhooks

- **API:**
  - `GET` and `POST /webhooks`
  - `GET`, `PUT`, `PATCH`, and `DELETE /webhooks/:id`, where delete requires `force=true`
  - `POST /webhooks/batch`
  - Fields match WooCommerce: `secret` is write-only, and `api_version` comes from the namespace used to create the webhook.
- **Storage:** add a `webhooks` adapter section with list, get, create, update, and delete. Serverless hosts cannot keep this state in memory. Hosts can also create webhooks programmatically, which replaces WordPress's admin screen for services that need a hand-configured delivery URL (Pabbly Connect, AfterShip Returns).
- **Delivery:**
  - Hosts call `emulator.webhooks.dispatch(topic, resourceId, { waitUntil })` when their data changes.
  - **Payload:** the resource serialized at the webhook's API version. `*.deleted` sends `{ id }`, and `action.*` sends `{ action, arg }`.
  - **Headers:** `X-WC-Webhook-Source`, `-Topic`, `-Resource`, `-Event`, `-Signature`, `-ID`, and `-Delivery-ID`.
  - **Signature:** the base64 HMAC-SHA256 of the raw body, computed with WebCrypto.
- **Ping:** creating a webhook sends a form-encoded `webhook_id=<id>` ping with no signature. n8n ignores requests without `X-WC-Webhook-ID` and relies on this.
- **Failures:** count consecutive failures and disable the webhook after a configurable threshold. WooCommerce's default is 5, set by `woocommerce_max_webhook_delivery_failures`. Do not follow redirects, and make the timeout configurable.
- **Topics:** `order`, `product`, `customer`, and `coupon`, each with `created`, `updated`, `deleted`, and `restored`. `action.*` topics pass through, so the host can fire, for example, `action.woocommerce_order_status_processing` for Printify.
- **Security:** validate `delivery_url`. Require HTTPS by default, block private and loopback addresses to prevent SSRF, and support an optional allowlist.

**Exit criteria:** an n8n WooCommerce Trigger workflow activates, receives a signed `order.updated` event, and deactivates cleanly.

**Expected to unlock:**
- Automation triggers: the n8n Trigger, Pipedream sources, Make instant triggers, Integrately, Albato, Pabbly Connect
- Returns: AfterShip Returns' plugin-free route
- Order intake: Apliiq, and Printify's order intake
- Partial: Metorik (with Phase 4) and DSers (with product creation)

### Phase 3: Products, variations, and stock

- **Reads:**
  - `GET /products`, filtered by `sku`, `status`, `type`, `search`, `include`, and `modified_after`, with pagination
  - `GET /products/:id`
  - `/products/:id/variations` and individual variations
  - `/products/categories`, `/products/tags`, and `/products/attributes` with their terms
- **Limited writes:**
  - `PUT` and `PATCH` on `/products/:id` and `/products/:id/variations/:id` accept only `stock_quantity`, `manage_stock`, `stock_status`, `regular_price`, and `sale_price`.
  - `/products/batch` and `/variations/batch` accept the same fields.
  - Any other field returns a 400 error that names the field as unsupported.
- **Adapter:** add a `products` section with list, get, variation lookup, stock update, and price update. Product and variation IDs follow the same stable-ID rules as orders (`wooCommerceId`).
- **Line items:** order line items reference the same product and variation IDs, which ties this phase to Phase 1.

**Exit criteria:** Channable imports the catalog. One stock-syncing tool, such as Zoho Inventory, Katana, or Stock Sync, completes a round trip.

**Expected to unlock:**
- Shipping: item weights for Pirate Ship and ShippingEasy; ShipBob, Flexport, Shiprocket
- Inventory: Cin7 Core, Zoho Inventory, Katana, inFlow, Unleashed (stock), Linnworks, Stock Sync (updates)
- Feeds and catalog: Channable and GoDataFeed feeds, Attentive
- Product linking: SKU-based linking for Gooten and CJdropshipping

### Phase 4: Customers, refunds, coupons, reports, and API keys

- **Customers:** `GET /customers`, filtered by `email`, `search`, `role`, and `modified_after`, with pagination; and `GET /customers/:id`.
- **Refunds:**
  - `GET /orders/:id/refunds` and individual refunds.
  - An optional `POST /orders/:id/refunds` through a `createRefund` hook. This moves money, so it must be explicitly enabled, and the host decides whether to refund through the payment gateway.
- **Coupons:** `GET /coupons` and `GET /coupons/:id`.
- **Reports:** `/reports/sales`, `/reports/top_sellers`, `/reports/customers/totals`, and `/reports/products/totals`.
- **Settings:** `GET /settings/general`, covering currency, weight and dimension units, and store address.
- **API keys:** replace the single key with a key store in a new `apiKeys` adapter section.
  - Keys carry `read`, `write`, or `read_write` permissions.
  - Permissions are checked per method. `GET` and `HEAD` need read; `POST`, `PUT`, `PATCH`, and `DELETE` need write. Failures return 401 `woocommerce_rest_authentication_error`.
  - `/wc-auth` mints a separate key for each app through `createApiKey`, returns the real `key_id`, and deletes the key if the callback fails.
  - `/wc-auth` accepts `read` and `write` scopes.
  - The existing `auth: { consumerKey, consumerSecret }` configuration keeps working as a single `read_write` key.
- **Optional:** verify one-legged OAuth 1.0a for clients that use `http` URLs, with a nonce store in the adapter. This is low priority because production deployments should use HTTPS.

**Expected to unlock:**
- Inventory and ERP: Katana, Odoo, the Celigo template
- Helpdesks: Gorgias, Zendesk (Zenplates), Zoho Desk
- Accounting: Synder, Link My Books, the QuickBooks connector
- Read-only connections: Craftybase and Stocksmith
- Full syncs: Airbyte, Fivetran, and Coupler.io
- Analytics: Metorik and Glew

## Open decisions

1. **Product creation for print-on-demand and dropshipping.**
   - **Who needs it:** Printful, Printify, Gelato, Gooten, DSers, AutoDS, and CJdropshipping create products and then match orders against them. inFlow, Unleashed, and Stock Sync also create products in some modes.
   - **What it involves:** the adapter would have to accept WooCommerce's variable-product model (attributes, variations, and images by URL) and store images.
   - **Options:**
     - Do not support these services.
     - Add an opt-in `productWrites` adapter section once Phase 3 proves the read model.
     - Publish a separate package.
   - **Recommendation:** the opt-in section, with Gooten as the first reference client. Gooten can also link existing products by SKU, which gives an incremental path.
2. **Order creation (`POST /orders`).**
   - **Who needs it:** GoDataFeed's marketplace order sync and ReturnGO's exchange orders.
   - **What it involves:** the surface is modest, but it writes orders into the host system.
   - **Recommendation:** support it through an opt-in hook after Phase 4.
3. **Legacy REST API (`/wc-api/v3`).**
   - **Who needs it:** Ordoro, SkuVault Core, Cin7 Omni, and ShipHero. Gelato's connection check may also depend on it.
   - **Against:** WooCommerce removed it from core in 9.0, and vendors are moving away from it.
   - **Recommendation:** defer until a user needs one of those services. If it is built, ship it as a separate entry point such as `wooemulate/legacy`.
4. **Plugin-namespace shims** such as `wc-shipstation/v1`, `klaviyo/v1`, `wc-zapier/v1`, `wc/v2/printful`, and `omnisend-api/v1`.
   - **Against:** these are vendor-internal contracts that can change without notice, and onboarding for these services usually starts in the WordPress admin.
   - **Recommendation:** keep them out of core. For ShipStation, separately investigate its non-WooCommerce integration options, such as its custom-store integration; this research did not verify them.
5. **Empty collections for health checks.** *Resolved: implemented as the opt-in `emptyCollections` option.*
   - **The problem:** n8n's credential test calls `/products/categories`, which fails until Phase 3.
   - **Recommendation:** allow an explicit, opt-in list of read-only collection routes that return an empty list. This lets stores without that resource pass connection checks, and it stays off by default.
6. **Breaking defaults in Phase 0.** *Resolved: accepted and recorded in the changelog.*
   - **What changes:** the `per_page` default, out-of-range rejection, and the date format.
   - **Recommendation:** accept these changes in 0.x and record them in the changelog.

## Verification strategy

1. **Conformance tests in CI, with no third-party accounts.**
   - Run the official WooCommerce REST API clients for JavaScript, PHP, and Python in both Basic and query-string modes.
   - Run singer-io `tap-woocommerce` and PyAirbyte `source-woocommerce` against the example server. Airbyte requires HTTPS, so use mkcert or a tunnel.
   - Import and execute n8n workflows with `n8n import:workflow` and `n8n execute`. Add the Trigger workflow after Phase 2.
   - Validate responses against the JSON schemas in Airbyte's connector manifest and against snapshots from a real WooCommerce install, taken with `?context=help` or `OPTIONS`.
2. **Differential testing.** Run real WooCommerce in `wp-env` with the same fixture orders, then compare status codes, headers, and bodies for identical requests.
3. **Third-party end-to-end tests.** For each service, record:
   - the service, date, and plan
   - the connection method
   - the endpoints observed through the Phase 0 request observer
   - the import and update scenarios, with sanitized fixtures

   Add a service to the README compatibility table only after this record exists. For one-click services, capture the callback and return URLs, which must be added to `oauth.allowedCallbackUrls` and `oauth.allowedReturnUrls`.

**Test order:**

| When | Services |
| --- | --- |
| Now | Starshipit (Shipment Tracking mode), the n8n order nodes, Pipedream actions, the singer tap |
| After Phase 0 | Airbyte |
| After Phase 1 | Pirate Ship, ShippingEasy, Shippo |
| After Phase 2 | The n8n Trigger |
| After Phase 3 | Channable, ShipBob or Flexport |
