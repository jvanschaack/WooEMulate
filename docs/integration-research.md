# Integration research: services that connect to WooCommerce

_Researched October 2026. This is a desk survey of vendor help centers, open-source client code, and WordPress.org plugin source. None of these services has been tested end to end against WooEMulate. Treat every entry as a hypothesis to verify, not a compatibility claim._

Pirate Ship was the first target, but many other services offer a "Connect WooCommerce" option. This survey records how about 140 of them connect, what they read and write, and which [roadmap](roadmap.md) phase would make each one testable.

## Reading the tables

**Phase** is the earliest roadmap phase that covers every documented requirement of the service.

| Label | Meaning |
| --- | --- |
| Now | Plausible with today's endpoints, sometimes only with a specific service setting. Ready for an end-to-end test. |
| P0–P4 | Needs the generic WooCommerce features delivered in that [roadmap phase](roadmap.md#phases). |
| Decision | Needs product or order creation through the API. See [open decisions](roadmap.md#open-decisions). |
| Legacy | Needs the legacy `/wc-api/v3` API, which was removed from WooCommerce core in 9.0. |
| Shim | Needs routes registered by a vendor's WordPress plugin, such as `/wp-json/wc-shipstation/v1`. |
| Out | A vendor WordPress plugin, PHP bridge file, or direct database connection performs the sync. A REST emulator cannot replace it. |
| N/A | No WooCommerce integration: Shopify-only, discontinued, or none found. |

**Confidence** reflects the evidence. High means vendor documentation or source code states it. Medium means it is partly documented and partly inferred. Low means the evidence is thin or indirect. A ✓ marks a claim rechecked directly while writing this document.

## Key findings

### 1. The connection model decides feasibility before the endpoints do

| Connection model | Examples | WooEMulate today |
| --- | --- | --- |
| Manual consumer key and secret plus store URL | Starshipit, Flexport, Zoho Inventory, n8n, Airbyte, eDesk, Channable | Supported through HTTPS Basic auth or query-string credentials. |
| One-click `/wc-auth/v1/authorize` | ShippingEasy, Katana, inFlow, Unleashed, Gooten, DSers, AutoDS; likely Pirate Ship | Supported when the service's callback and return URLs are allowlisted. It hands out one shared `read_write` key and rejects `read` and `write` scopes. |
| Plugin used only for onboarding; data moves over REST | Klaviyo, Omnisend, Printful, Gelato, Easyship | Needs plugin-route shims, and onboarding usually starts from a WordPress admin screen. |
| Plugin performs the sync by pushing data out of WordPress | Mailchimp, ActiveCampaign, Judge.me, Yotpo, TaxJar, Avalara, Google and Meta channels, MyWorks, Xero | Out of reach. |
| Bridge file or database access | Veeqo (Bridge2Cart), DataFeedWatch (API2Cart bridge), Sellercloud, Hevo (MySQL) | Out of reach. |

### 2. Order notes are the main tracking write-back, not Shipment Tracking

Pirate Ship, Shippo, ShippingEasy, AfterShip Shipping, Ship&co, Ordoro, Printful, Printify, CustomCat, and Linnworks write tracking into order notes. Starshipit and Extensiv Integration Manager default to notes. Both also offer a Shipment Tracking extension mode ✓, which WooEMulate already serves. WooEMulate does not implement `/orders/:id/notes`.

### 3. Webhooks drive every instant trigger

n8n, Pipedream, Make, Integrately, Albato, Metorik, Printify, Apliiq, DSers, ShipHero, and Klaviyo register webhooks through `POST /wc/v3/webhooks`. They expect signed deliveries with `X-WC-Webhook-*` headers. Pabbly Connect and AfterShip Returns' plugin-free route need delivery only; the merchant configures the destination URL by hand.

### 4. Product reads are the next most common need

Shipping tools read item weights and SKUs. Inventory tools match products by SKU and push stock levels. Feed tools export the catalog. Print-on-demand and dropshipping tools match order lines to products they created or linked.

### 5. Small protocol mismatches break real clients today

- **Missing `Link` header.** n8n's "Return All" calls `responseData.headers.link.split(',')` unconditionally ✓. WooEMulate sends no `Link` header, so the request throws.
- **Airbyte's requirements.** Its connection check calls `/system_status/tools`. It pages with `offset`, filters with `modified_after` and `modified_before`, and parses `date_modified_gmt` as `%Y-%m-%dT%H:%M:%S`. WooEMulate routes none of these parameters and passes adapter date strings through unformatted.
- **Page size.** WooCommerce's default `per_page` is 10. WooEMulate uses 50 and clamps out-of-range values instead of rejecting them.
- **Linnworks' connection test.** It calls `GET /reports/orders/totals`.
- **Read-only one-click.** Craftybase and Stocksmith request `scope=read`, which the authorize handler rejects.

### 6. Several categories are effectively plugin-only

This covers email and SMS marketing, reviews, sales tax, the Xero, MyWorks, and Webgility accounting connectors, and the Google, Meta, TikTok, and Pinterest channels. Many of these vendors also publish their own APIs or "custom platform" integrations. A custom store can usually integrate with them directly, which works better than emulating WooCommerce.

Zapier also belongs in this group. Its current WooCommerce integration uses a paid WordPress plugin and the plugin's private `wc-zapier/v1` routes. n8n, Make, and Pipedream are the realistic automation paths.

### 7. Product creation is the core of print-on-demand and dropshipping

Printful, Printify, Gelato, Gooten, DSers, AutoDS, CJdropshipping, Spocket, and Syncee push products into the store. They then route orders by matching `product_id`, `variation_id`, or SKU against those products. Supporting them means writing WooCommerce's variable-product model into the host database. That is a design decision rather than an endpoint.

## Best near-term test targets

| Target | Why | Phase | Access |
| --- | --- | --- | --- |
| Starshipit | Manual v3 keys and a Shipment Tracking write-back mode ✓ | Now | Trial (unverified) |
| Extensiv Integration Manager | Shipment Tracking is its recommended confirmation method ✓ | Now | Sales-led |
| singer-io `tap-woocommerce` | Reads `wc/v2/orders` with `after`, `orderby`, and `page`; the fields it reads are already serialized | Now | Open source |
| n8n WooCommerce node | Open source; covers order list, get, and update, then webhooks | Now (with a limit), P0 (Return All), P2 (Trigger) | Self-hosted, free |
| Pipedream WooCommerce actions | Uses the official JavaScript client | Now, P2 (sources) | Free tier |
| eDesk | Manual keys; only orders are documented | Now | Trial |
| Airbyte `source-woocommerce` | Certified connector whose JSON schemas can serve as contract tests | P0 (orders), P4 (all streams) | Open source (PyAirbyte) |
| Pirate Ship | Original target; needs notes and probably product weights | P1, possibly P3 | Free |
| ShippingEasy and Shippo | Widely used small-business shipping tools that write tracking as notes | P1, possibly P3 | Trial and free |

## Compatibility by category

### Shipping, fulfillment, and tracking

| Service | Connection | Reads and writes | Webhooks | Phase | Confidence |
| --- | --- | --- | --- | --- | --- |
| Starshipit | Manual keys, "Version 3" ✓ | Orders by status; writes Completed plus an order note, or Shipment Tracking fields ✓ | None mentioned | Now (Shipment Tracking mode), P1 (note mode) | High |
| Extensiv Integration Manager | Manual keys (Read/Write) | Order download; six confirmation methods, with notes as the default and Shipment Tracking recommended ✓; inventory sync | Not documented | Now (Shipment Tracking mode), P1, P3 (inventory) | High |
| ShipWise | Manual keys | "In Process" orders; recommends the Shipment Tracking extension | None mentioned | Now | Medium-low |
| Rollo | One-click approve | Orders; tracking mechanism undocumented | None mentioned | Now–P1 | Low |
| PitneyShip | Manual keys | Orders; write-back undocumented | None mentioned | Now–P1 | Low |
| Shipmondo | Manual keys | Orders; optional tracking push, mechanism undocumented | None mentioned | Now–P1 | Low |
| Pirate Ship | Store URL, then WooCommerce login, then approve (wc-auth inferred); health check `GET /wp-json/wc/v1` | Processing orders; sets Completed with PUT; tracking as a private or customer order note; item weights, likely from products | Polling | P1, possibly P3 | Medium |
| Shippo | In-app connect, mechanism undocumented; troubleshooting checks `/wp-json/wc/v1` | Orders; tracking in order notes | Unknown | P1 | Medium-low |
| ShippingEasy | One-click approve | Pending, processing, and on-hold orders; tracking as an order note plus status; item name, weight, and SKU | Polling | P1, possibly P3 | High |
| AfterShip Shipping | One-click approve; manual keys through support | Orders; status, notes, and tracking | Not mentioned | P1 | Medium |
| Ship&co | Manual keys | Orders; sets Completed and adds a customer or private note | Possibly | P1, possibly P2 | Medium |
| Shiprocket | One-click approve or manual keys | Orders, products, inventory, status | Not documented | P3 | Medium |
| ShipBob | One-click approve | Products (SKU, weight, dimensions), stock writes, processing orders, tracking plus Completed | Polling | P3 | Medium-low |
| Flexport (formerly Deliverr) | Manual keys, no plugin | Products by SKU, stock writes, orders, tracking | Not mentioned | P3 | Medium-high |
| ShipEdge | Manual keys | Orders, tracking through a WordPress plugin (likely Shipment Tracking), inventory | Unknown | Now–P3 | Low |
| ShipHero | Manual keys; docs say Legacy v3, troubleshooting checks `wc/v3` | Orders, products, tracking | Yes, "Shiphero" webhooks | Legacy, P2 | Medium |
| Ordoro | Manual keys; Legacy REST API required | Orders, products, inventory write-back, tracking note | Hourly polling | Legacy | Medium-high |
| ShipStation | Plugin required (Auth Key plus consumer keys) | `/wp-json/wc-shipstation/v1/*` and an XML export | No | Shim | High |
| Stamps.com | "Authorization Key", likely the ShipStation plugin's | Orders | Unknown | Shim | Low-medium |
| Easyship | Plugin creates the keys and registers its own OAuth 1.0a route | Orders, notes | Unknown | Shim | Medium |
| AfterShip Tracking | Plugin plus approval | Plugin routes such as `/aftership-api/v5/*` | — | Shim | Medium |
| Sendcloud | Plugin required; Legacy API on WooCommerce 9+ | Orders, service points | Plugin manages webhooks | Shim or Out | Medium |
| Veeqo | Plugin plus Bridge2Cart bridge URL | Orders, stock | — | Out | Medium-high |
| ShipWorks | Third-party plugin implementing the ShipWorks Generic Module | Orders | — | Out | Medium |
| Packlink PRO, Sendle, Route, ParcelPanel | Plugin pushes data or renders WordPress pages | — | — | Out | Medium |

Advanced Shipment Tracking (AST) registers the same `orders/:id/shipment-trackings` controller under the `wc-shipment-tracking/v3` and `wc-ast/v3` namespaces. Aliasing those namespaces costs little and helps tools configured for AST (Phase 0).

### Automation, ETL, and analytics

| Service | Connection | Uses | Webhooks | Phase | Confidence |
| --- | --- | --- | --- | --- | --- |
| n8n WooCommerce node | Manual keys; Basic auth or "Include Credentials in Query" | Orders get, get many, and update; products and customers; the credential test calls `/products/categories` | — | Now (get many with a limit), P0 (Return All) | High (source) ✓ |
| n8n WooCommerce Trigger | Manual keys | `GET/POST/DELETE /webhooks`; verifies the signature and ignores requests without `X-WC-Webhook-ID` | Creates them through the API | P2 | High (source) |
| Pipedream | Manual keys through the official JavaScript client, which switches to OAuth 1.0a on `http` URLs | Orders, products, customers, coupons, notes, refunds | Sources create them through the API | Now (order actions), P2 | High (source) |
| Make | Manual keys | Orders, products, customers, coupons, notes, raw API calls | "New Event" instant trigger | Now (order modules), P2 | Medium-low |
| singer-io `tap-woocommerce` | Manual keys | `wc/v2/orders` with `after`, `orderby`, `order`, `per_page`, and `page` | — | Now | High (source) |
| hotglue `tap-woocommerce` (Meltano) | Manual keys | Orders plus products, coupons, customers, subscriptions, notes, refunds, and settings; reads the `system_status` version and sends `modified_after` | — | P0 (orders), P4 | Medium-high |
| Airbyte `source-woocommerce` | Manual keys; HTTPS hard-coded | 21 streams; checks `/system_status/tools`; pages with `offset`; syncs in `modified_after`/`modified_before` windows with `dates_are_gmt` | — | P0 (orders), P4 | High (source) |
| Mixed Analytics API Connector (Google Sheets) | Keys in the query string or Basic auth | Any endpoint; pages through results with the `Link` header | — | Now, P0 | Medium-high |
| CData drivers (Power BI, Excel) | Manual keys | Full schema | — | Now (Orders table) | Low-medium |
| Google Cloud Integration Connectors | Manual keys | Orders CRUD | — | Now–P0 | Low |
| Coupler.io | Manual keys | Orders and line items, customers, coupons, products, reports | — | Now (orders), P3–P4 | Medium-low |
| Windsor.ai | Manual keys (read) | Orders, products, customers, coupons | — | Now–P4 | Low-medium |
| Pabbly Connect | Keys for actions; triggers use a delivery URL pasted into WooCommerce settings | Orders and other resources | Delivery only | Now (actions), P2 | Medium |
| Integrately, Albato | Keys or one-click approve | Various | Likely created through the API | P2 | Low-medium |
| IFTTT | Undocumented | New order, new paid order, new customer | Polls | Unclear | Low |
| Fivetran (Lite) | Manual keys | Orders, coupons, products | — | P3–P4 | Medium-low |
| Metorik | One-click | Orders, customers, products, subscriptions, refunds | Creates them, plus a 10-minute backup sync | P2, P4 | Medium |
| Glew | WooCommerce login, probably wc-auth | Orders, customers, products, refunds | Unknown | P4 | Low |
| Databox, Supermetrics | Manual keys | WooCommerce Analytics (`wc-analytics`) or legacy reports | — | Shim | Low |
| Zapier | WordPress admin login with an application password, plus the paid WooCommerce Zapier plugin | `/wc-zapier/v1/*` | Through the plugin | Shim | High |
| Microsoft Power Automate and Logic Apps | Paid plugin | `/wc-powerautomate/v1/*` | Through the plugin | Shim | High |
| Hevo | Direct MySQL connection | — | — | Out | High |
| Putler | Plugin | — | — | Out | Medium |

### Accounting, tax, inventory, ERP, and order management

| Service | Connection | Uses | Webhooks | Phase | Confidence |
| --- | --- | --- | --- | --- | --- |
| Celigo integrator.io | Manual keys (Basic auth) | Custom flows; the template uses products, orders, customers, status, and refunds | Optional | Now (custom order flows), P3–P4 | Medium |
| Zoho Inventory | Manual keys plus domain | Orders, items by name or SKU, stock push, customers | Polling, configurable | P3, possibly P4 | High |
| Katana | One-click | Open orders, two-way status, product, stock, and customer import, stock push | — | P3, P4 | High |
| inFlow | One-click | Orders, product pull and push (stock, price, images, weight), variants, fulfillment, tax schemes | — | P3; product push is a Decision | High |
| Unleashed | One-click | Product export as drafts, stock every 15 minutes, processing orders, customers | Polling | P3–P4; draft export is a Decision | High |
| Linnworks | Manual keys (query string and Basic) | Connection test calls `GET /reports/orders/totals`, then `system_status`; orders; stock and price; tracking through notes | — | P0 (connection), P1, P3 | Medium |
| Stock Sync | Manual keys | Product creation; stock and price updates by SKU or barcode | Scheduled | P3; creation is a Decision | High |
| Cin7 Core | OAuth by default (likely one-click), with manual keys as a fallback | Orders, stock push | — | P3 | Medium |
| Craftybase / Stocksmith | One-click with `scope=read`; re-authorizes for stock push | Products and variations, orders, refund adjustments, `date_paid` | Scheduled | P3, P4 (scopes) | Medium |
| Synder | One-click | Orders with taxes and products, fees | — | P1 (tax and fee fidelity), P4 (refunds) | Medium |
| Link My Books (beta) | Manual read key | Sales, refunds, fees, sales tax | — | P1, P4 | Medium |
| Intuit QuickBooks WooCommerce connector | Undocumented | Orders become invoices or receipts; products by SKU; stock; refunds become credit notes; tax mapping | Hourly | P3–P4 | Low |
| Amaka (Xero) | Undocumented | Daily sales, payments, tax, fees | Daily | P1–P4 | Low |
| Odoo connectors (for example Asksol) | Manual keys | Customers, categories, tags, attributes, products and variations, orders, refunds, coupons; pushes stock, price, and tracking notes | HMAC-signed webhooks plus scheduled jobs | P2–P4 | Medium |
| Brightpearl, Finale Inventory | Undocumented | Products, inventory, orders, tracking | — | P3 or later | Low |
| Ordoro, SkuVault Core, Cin7 Omni | Manual keys; Legacy REST API required | Orders, products, inventory | Polling | Legacy | Medium-high |
| MyWorks Sync, Webgility, Xero for WooCommerce, TaxJar, Avalara AvaTax, Quaderno, Megaventory, Sellbrite, Sellercloud | Plugin or PHP files on the store | — | — | Out | High |
| A2X, Zoho Books, Sage, FreshBooks, Wave, Rithum (ChannelAdvisor), Extensiv Order Manager | No native WooCommerce connector found | — | — | N/A | Medium to low |

Accounting tools depend on order data fidelity more than on new endpoints. Today the serializer fills in placeholders:
- `tax_lines` is empty, and `cart_tax`, `shipping_tax` and the line-item taxes are zeroed. Only `total_tax` carries a real value.
- `refunds` is an empty array.
- `customer_id` is 0.
- `date_paid` equals the creation date.
- `product_id` is synthesized when an item has no numeric ID.

Books built from that data would be wrong. Phase 1 addresses this.

### Helpdesk, CRM, marketing, reviews, and returns

| Service | Connection | Uses | Webhooks | Phase | Confidence |
| --- | --- | --- | --- | --- | --- |
| eDesk | Manual keys | Orders | Not documented | Now | Medium-low |
| Re:amaze | Store URL plus keys | Orders matched to the customer's email; refunds, status updates, notes | — | Now (viewing), P1 (notes), P4 (refunds) | Medium-low |
| Zoho Desk | Manual keys plus base URL | Customers, orders, addresses, editable notes | — | P1, P4 | Medium |
| Zendesk (Zenplates app) | Manual keys | Customers, orders, order search | — | P4 | Medium |
| Gorgias | "Authorize App" (wc-auth inferred) | Customers, orders, products; read-only | Likely | P2–P4 | Medium-low |
| Attentive | One-click approve plus a JavaScript tag the host can add itself | Product catalog, which requires SKUs | — | P3 | Medium |
| AfterShip Returns (plugin-free route) | Read/write key sent to support, plus an IP allowlist | Orders and line items | Manually created "Order updated" webhook | P2 | Medium |
| ReturnGO (Enterprise plan) | Read/write key | Orders, refunds, exchange orders it creates | — | P4, Decision | Medium |
| Drip | Plugin (JavaScript snippet, extra webhook header, cart action topic) plus keys | Customers, orders, products | Yes, including a custom `action.*` topic | P2–P4, plus a host-side snippet | Medium |
| Klaviyo, Omnisend, Brevo, Constant Contact | Plugin required; each plugin registers its own routes | Orders, products, customers; webhooks through REST | Yes | Shim | Medium |
| Help Scout | Paid plugin plus Legacy API | — | — | Out | Medium |
| Mailchimp, ActiveCampaign, HubSpot (MakeWebBetter), MailerLite, Richpanel, Judge.me, Yotpo, Trustpilot, Stamped, REVIEWS.io, Salesforce connectors | Plugin pushes data from WordPress | — | — | Out | High |
| Postscript, LoyaltyLion, Smile.io, WeSupply, Returnly | No WooCommerce integration: Shopify-only, none native, or shut down | — | — | N/A | Medium |

### Print-on-demand, dropshipping, marketplaces, and feeds

| Service | Connection | Uses | Webhooks | Phase | Confidence |
| --- | --- | --- | --- | --- | --- |
| Channable | Manual keys | Reads products, including meta fields | — | P3 | High |
| GoDataFeed | Manual keys (v1–v3) | Reads products daily; creates marketplace orders; reads tracking from notes or Shipment Tracking | — | P3 (feeds); order sync is a Decision | High |
| CustomCat | Undocumented | Processing orders; tracking note plus Completed | — | P1 | Low |
| Apliiq | One-click | Orders; fulfillment through AST routes | `order.*` webhooks | P2, with the Phase 0 AST alias | Medium |
| Printify | Store URL then approve (wc-auth inferred) | Pushes products; processing orders; tracking notes | `action.woocommerce_order_status_processing` | Decision, plus P1 and P2 | High to medium |
| Gooten | One-click approve | Publishes products or links existing ones by SKU; only linked products' orders route | — | P3 (linking), Decision (publishing) | Medium-high |
| CJdropshipping | Manual keys | Lists or links products; imports orders | — | P3, Decision | Medium |
| DSers | One-click approve | Imports products; stock and price; orders; tracking | Creates them | Decision, P2, P3 | Medium |
| AutoDS | One-click | Uploads products and images; stock and price; orders | — | Decision | Medium-high |
| Feedonomics | Undocumented | Products (inferred) | — | P3 | Low |
| Printful | Plugin starts the connection, then wc-auth; plugin routes `wc/v2/printful/*` | Pushes products; orders; tracking note | — | Shim, Decision | Medium |
| Gelato | Plugin plus Legacy API; expects six named webhooks | Pushes products; orders | Yes | Shim, Legacy | Medium |
| Syncee, CedCommerce | Callback or routes hosted by the plugin | — | — | Shim or Out | Medium |
| SPOD/Spreadconnect, teelaunch, Spocket, Faire, Codisto, WP-Lister, DataFeedWatch | Plugin performs the sync, or a bridge file is required | — | — | Out | Medium-high |
| Google for WooCommerce, Meta for WooCommerce, TikTok, Pinterest | Plugin pushes the catalog or builds a feed | — | — | Out | High |
| Modalyst, Zendrop | No WooCommerce integration (Zendrop discontinued it in 2023) | — | — | N/A | Medium-high |

For Google, Meta, and Pinterest, a custom store is better served by a scheduled product feed or those platforms' own APIs than by WooCommerce emulation.

## Feature demand

| Feature | Services that need it (examples) | Phase |
| --- | --- | --- |
| Pagination and filter parity: `Link`, `offset`, `modified_after`, date format, `per_page` | n8n, Airbyte, hotglue tap, Mixed Analytics, Metorik, any incremental poller | P0 |
| Order notes | Pirate Ship, Shippo, ShippingEasy, AfterShip Shipping, Ship&co, Starshipit, Extensiv, Ordoro, Printful, Printify, CustomCat, Linnworks, GoDataFeed, Re:amaze, Zoho Desk, Odoo | P1 |
| Order data fidelity: tax lines, fees, real product IDs, `date_paid` | Synder, Link My Books, QuickBooks connector, Amaka, inventory tools matching SKUs | P1 |
| Webhooks (CRUD API and signed delivery) | n8n Trigger, Pipedream, Make, Integrately, Albato, Metorik, Pabbly, AfterShip Returns, Printify, Apliiq, DSers, ShipHero, Gorgias, Odoo, Drip, Klaviyo | P2 |
| Product and variation reads | Pirate Ship (weights), ShippingEasy, ShipBob, Flexport, Shiprocket, Zoho Inventory, Katana, inFlow, Unleashed, Linnworks, Stock Sync, Cin7 Core, Craftybase, Channable, GoDataFeed, Attentive, Gorgias, Gooten | P3 |
| Stock and price writes | ShipBob, Flexport, Shiprocket, Zoho Inventory, Katana, inFlow, Linnworks, Stock Sync, Cin7 Core, DSers, AutoDS | P3 |
| Customer reads | Katana, Gorgias, Zendesk (Zenplates), Zoho Desk, Odoo, Celigo, Drip, Airbyte | P4 |
| Refunds | Synder, Link My Books, QuickBooks connector, Craftybase, Re:amaze, ReturnGO, Odoo | P4 |
| Per-key scopes | Craftybase and Stocksmith; safer one-click connections for every service | P4 |
| Product creation | Printful, Printify, Gelato, Gooten, DSers, AutoDS, CJdropshipping, Unleashed, Stock Sync, inFlow | Decision |
| Order creation | GoDataFeed order sync, ReturnGO exchanges | Decision |
| Legacy `/wc-api/v3` | Ordoro, SkuVault Core, Cin7 Omni, ShipHero, Gelato, Help Scout | Decision |

## Sources

### WooCommerce protocol

- REST API docs: https://woocommerce.github.io/woocommerce-rest-api-docs/
- WooCommerce source (`plugins/woocommerce/` in https://github.com/woocommerce/woocommerce): `includes/class-wc-auth.php`, `includes/class-wc-webhook.php`, `includes/class-wc-rest-authentication.php`, `includes/rest-api/Controllers/Version3/`
- Official clients: https://github.com/woocommerce/woocommerce-rest-api-js-lib, https://github.com/woocommerce/wc-api-php, https://github.com/woocommerce/wc-api-python
- Community OpenAPI specifications: https://github.com/wtx-labs/woocommerce-api-openapi-specification, https://github.com/migkapa/woocommerce-openapi-spec

### Shipping, fulfillment, and tracking

- Pirate Ship: https://support.pirateship.com/en/articles/1515789-how-does-the-woocommerce-integration-work, https://support.pirateship.com/en/articles/4622809-troubleshoot-common-woocommerce-integration-problems
- Shippo: https://support.goshippo.com/hc/en-us/articles/207450406, https://support.goshippo.com/hc/en-us/articles/360024612052
- ShippingEasy: https://support.shippingeasy.com/hc/en-us/articles/4405329626779-WooCommerce
- Starshipit: https://support.starshipit.com/articles/203826249
- Extensiv Integration Manager: https://help.extensiv.com/366919-woocommerce/1624674-setting-up-woocommerce, https://help.extensiv.com/en_US/1624682-woocommerce-confirmation-methods
- Ordoro: https://support.ordoro.com/how-do-i-find-my-woocommerce-api-keys/, https://support.ordoro.com/can-ordoro-post-tracking-numbers-into-woocommerce/
- ShipStation: https://woocommerce.com/document/shipstation-for-woocommerce/, https://help.shipstation.com/hc/en-us/articles/360026141671-WooCommerce
- ShipHero: https://software-help.shiphero.com/hc/en-us/articles/4419336213773
- ShipBob: https://support.shipbob.com/s/article/WooCommerce-Initial-Setup
- Shiprocket: https://www.shiprocket.in/knowledgebase/woocommerce-channel-integration/
- Flexport: https://support.portal.flexport.com/hc/en-us/articles/1500011373142
- Sendcloud: https://support.sendcloud.com/hc/en-us/articles/360024966732
- Veeqo: https://help.veeqo.com/en/articles/4254967-connecting-your-woocommerce-store-via-plugin
- AfterShip: https://support.aftership.com/en/articles/15380835-integrate-wordpress-woocommerce-with-aftership-shipping
- Ship&co: https://support.shipandco.com/hc/en-us/articles/115002331033
- ShipWise: https://info.shipwise.com/knowledge/woocommerce
- Rollo: https://support.rollo.com/support/solutions/articles/29000039013-woocommerce
- Shipmondo: https://help.shipmondo.com/en/articles/2027780-woocommerce-webshop-integration-setup
- AST shipment-tracking routes: https://docs.zorem.com/docs/ast-free/add-tracking-to-orders/shipment-tracking-api/

### Automation, ETL, and analytics

- n8n: https://github.com/n8n-io/n8n/tree/master/packages/nodes-base/nodes/WooCommerce
- Airbyte: https://github.com/airbytehq/airbyte/tree/master/airbyte-integrations/connectors/source-woocommerce
- Singer taps: https://github.com/singer-io/tap-woocommerce, https://github.com/hotgluexyz/tap-woocommerce
- Pipedream: https://github.com/PipedreamHQ/pipedream/tree/master/components/woocommerce
- Make: https://apps.make.com/woocommerce
- Zapier: https://help.zapier.com/hc/en-us/articles/8495989524621
- Power Automate: https://learn.microsoft.com/en-us/connectors/woocommerce/
- Pabbly Connect: https://www.pabbly.com/how-to-set-up-webhook-inside-woocommerce-using-pabbly-connect/
- Fivetran: https://fivetran.com/docs/connectors/applications/woocommerce
- Coupler.io: https://docs.coupler.io/sources/category/ecommerce/woocommerce
- Metorik: https://help.metorik.com/article/61-can-i-turn-off-metoriks-webhooks-that-are-set-up-for-my-store
- Mixed Analytics: https://mixedanalytics.com/knowledge-base/import-woocommerce-data-google-sheets/

### Accounting, inventory, ERP, and order management

- QuickBooks: https://quickbooks.intuit.com/learn-support/en-uk/help-article/manage-integrations/connect-woocommerce-quickbooks-online-quickbooks/L74dHvL1X_GB_en_GB
- Synder: https://synder.com/help/how-to-connect-woocommerce-to-synder/
- A2X: https://support.a2xaccounting.com/faqs/does-a2x-handle-sales-and-fees-from-other-channels-such-as-shopify-magento-or-ebay
- Link My Books: https://help.linkmybooks.com/en/articles/9116049-how-to-connect-woocommerce
- Zoho Inventory: https://www.zoho.com/inventory/help/integrations/woo-commerce.html
- inFlow: https://inflowinventory.com/support/cloud/connecting-inflow-to-woocommerce
- Katana: https://support.katanamrp.com/en/articles/5968238-connecting-woocommerce
- Unleashed: https://intercom.help/unleashed-support/en/articles/11582194-woocommerce-integration-set-up
- Linnworks: https://wordpress.org/support/topic/linnworks-connection-invalid/
- SkuVault Core: https://woocommerce.com/document/skuvault-core-woocommerce-documentation/
- Stock Sync: https://help.stock-sync.com/en/article/what-features-does-stock-sync-support-when-connecting-to-woocommerce-1qwz4c8/
- Stocksmith: https://help.stocksmith.io/article/898-connect-woocommerce
- TaxJar: https://woocommerce.com/document/taxjar/
- Avalara AvaTax: https://woocommerce.com/document/avalara-avatax/
- Celigo: https://www.celigo.com/integration/netsuite-woocommerce/

### Helpdesk, CRM, marketing, reviews, and returns

- eDesk: https://support.edesk.com/woocommerce-connection-guide
- Re:amaze: https://reamaze.godaddy.com/kb/3rd-party-integrations/woocommerce-how-to
- Gorgias: https://docs.gorgias.com/en-US/woocommerce-101-353478
- Zoho Desk: https://help.zoho.com/portal/en/kb/desk/for-administrators/integrations-and-add-ons/articles/woocommerce-for-zoho-desk
- Zendesk (Zenplates): https://www.zendesk.com/marketplace/apps/support/273938/woocommerce-by-zenplates/
- Attentive: https://help.attentive.com/hc/en-us/articles/8296440330004-WooCommerce
- AfterShip Returns: https://support.aftership.com/en/returns/articles/15390421-connect-woocommerce-to-returns-center
- ReturnGO: https://support.returngo.ai/integrating-your-return-portal-woocommerce
- Drip: https://help.drip.com/hc/en-us/articles/4424695659277
- Klaviyo: https://help.klaviyo.com/hc/en-us/articles/115005255808
- Omnisend: https://support.omnisend.com/en/articles/1636174-omnisend-for-woocommerce-wordpress
- Mailchimp: https://mailchimp.com/help/connect-or-disconnect-mailchimp-for-woocommerce/
- Help Scout: https://docs.helpscout.com/article/323-woocommerce

### Print-on-demand, dropshipping, marketplaces, and feeds

- Printify: https://help.printify.com/hc/en-us/articles/4483637152401
- Printful: https://help.printful.com/hc/en-us/articles/50262567664273
- Gooten: https://help.gooten.com/hc/en-us/articles/360047733171
- Gelato: https://support.gelato.com/en/articles/8996500
- DSers: https://help.dsers.com/link-woocommerce-store/
- AutoDS: https://help.autods.com/en/articles/12699992
- CJdropshipping: https://blog.cjdropshipping.cn/detail/how-to-connect-woocommerce-manually
- Apliiq: https://help.apliiq.com/portal/en/kb/articles/how-to-install-apliiq-woocommerce-plugin
- GoDataFeed: https://help.godatafeed.com/hc/en-us/articles/115003594372
- Channable: https://helpcenter.channable.com/import-data/import-how-to/import-your-product-data/import-via-a-webshop/woocommerce
- Codisto: https://wordpress.org/plugins/codistoconnect/
- Zendrop: https://support.zendrop.com/en/articles/8176418
