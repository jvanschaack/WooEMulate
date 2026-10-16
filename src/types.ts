/**
 * WooEMulate Types
 * Core configuration, data structures, and adapter interfaces for WooCommerce API emulation.
 */

export type WooEmulateOrderStatus =
  | 'pending'
  | 'processing'
  | 'on-hold'
  | 'completed'
  | 'cancelled'
  | 'refunded'
  | 'failed'

export interface WooEmulateAddress {
  firstName: string
  lastName?: string
  company?: string
  address1: string
  address2?: string
  city: string
  state: string
  postalCode: string
  country?: string // e.g. 'US'
  email?: string
  phone?: string
}

export interface WooEmulateOrderItem {
  id?: string | number
  name: string
  sku?: string
  quantity: number
  unitPriceCents: number
  /** Line total after discounts. Defaults to unit price times quantity. */
  totalPriceCents?: number
  /** Line subtotal before discounts. Defaults to the line total. */
  subtotalCents?: number
  /** Tax on the line total. */
  taxCents?: number
  /** Tax on the line subtotal. Defaults to `taxCents`. */
  subtotalTaxCents?: number
  /** Per-rate taxes; `rateId` matches an entry in the order's `taxLines`. */
  taxes?: Array<{ rateId: number; totalCents: number; subtotalCents?: number }>
  /** Numeric API ID of the product. Serialized as 0 (as WooCommerce does for missing products) when omitted. */
  productId?: number
  /** Numeric API ID of the variation, or 0/omitted for simple products. */
  variationId?: number
  /** Parent product name, for variations. */
  parentName?: string
  imageUrl?: string
  taxClass?: string
  metadata?: Record<string, unknown>
  weightLb?: number
  dimensionsIn?: {
    length?: number
    width?: number
    height?: number
  }
}

export interface WooEmulateTaxLine {
  id?: number
  /** Tax rate ID, referenced by item and shipping `taxes`. */
  rateId: number
  /** WooCommerce rate code, for example `US-TX-STATE TAX-1`. */
  rateCode: string
  label: string
  compound?: boolean
  /** Tax on items and fees for this rate. */
  taxCents: number
  /** Tax on shipping for this rate. */
  shippingTaxCents?: number
  ratePercent?: number
}

export interface WooEmulateShippingLine {
  id?: number
  methodTitle: string
  methodId: string
  instanceId?: string
  totalCents: number
  taxCents?: number
  taxes?: Array<{ rateId: number; totalCents: number }>
  metadata?: Record<string, unknown>
}

export interface WooEmulateFeeLine {
  id?: number
  name: string
  totalCents: number
  taxCents?: number
  taxClass?: string
  taxStatus?: 'taxable' | 'none'
}

export interface WooEmulateCouponLine {
  id?: number
  code: string
  discountCents: number
  discountTaxCents?: number
}

/** Refund summary embedded in an order (`refunds` in the order response). */
export interface WooEmulateRefundSummary {
  id: number
  reason?: string
  /** Positive refunded amount; serialized as a negative total, as WooCommerce does. */
  totalCents: number
}

export interface WooEmulateTracking {
  id?: string | number
  trackingNumber: string
  carrier?: string
  dateShipped?: string | Date
  trackingUrl?: string
}

export interface WooEmulateOrder {
  id: string | number
  /** Stable, unique, persisted API ID. Required when id is not a positive numeric ID. */
  wooCommerceId?: number
  /** Numeric API ID of the parent order, if any. */
  parentId?: number
  orderNumber: string
  orderKey?: string
  createdVia?: string
  status: WooEmulateOrderStatus | string
  createdAt: string | Date
  updatedAt?: string | Date
  totalCents: number
  subtotalCents?: number
  shippingCents?: number
  /** Total tax (cart plus shipping). */
  taxCents?: number
  /** Tax on shipping. Defaults to the sum of `shippingLines[].taxCents`, else 0. */
  shippingTaxCents?: number
  /** Tax on items and fees. Defaults to `taxCents` minus shipping tax. */
  cartTaxCents?: number
  discountCents?: number
  discountTaxCents?: number
  pricesIncludeTax?: boolean
  currency?: string
  /** Numeric API ID of the customer; 0 or omitted for guest orders. */
  customerId?: number
  customerIpAddress?: string
  customerUserAgent?: string
  customer?: {
    name?: string
    email?: string
    phone?: string
  }
  shippingAddress: WooEmulateAddress
  billingAddress?: WooEmulateAddress
  items: WooEmulateOrderItem[]
  tracking?: WooEmulateTracking
  notes?: string
  paymentMethod?: string
  paymentMethodTitle?: string
  transactionId?: string
  paymentUrl?: string
  /**
   * When the order was paid. `null` means unpaid. When omitted, processing and completed orders
   * are treated as paid at creation and other statuses as unpaid.
   */
  paidAt?: string | Date | null
  /** When the order was completed. Defaults to the shipment date for completed orders. */
  completedAt?: string | Date | null
  /** Tax totals per rate. */
  taxLines?: WooEmulateTaxLine[]
  /** Shipping lines. When omitted, one line is synthesized from `shippingCents`. */
  shippingLines?: WooEmulateShippingLine[]
  feeLines?: WooEmulateFeeLine[]
  couponLines?: WooEmulateCouponLine[]
  refunds?: WooEmulateRefundSummary[]
  metadata?: Record<string, any>
}

export interface WooEmulateOrderNote {
  /** Numeric note ID, unique within the store. */
  id: number
  note: string
  /** True for notes visible to (and emailed to) the customer. */
  customerNote: boolean
  /** `system` for automated notes, otherwise the author's display name. Defaults to `system`. */
  author?: string
  createdAt: string | Date
}

export interface WooEmulateOrderNoteInput {
  note: string
  /** WooCommerce emails customer notes to the customer; the host decides whether to send one. */
  customerNote: boolean
  /** True when the note is attributed to the API user rather than the system. */
  addedByUser: boolean
}

export interface WooEmulateListOrdersParams {
  status?: string | string[]
  /** 1-based page. Always set; derived from `offset` when the client pages by offset. */
  page?: number
  perPage?: number
  /** Number of matching orders to skip. Always set; authoritative over `page`. */
  offset?: number
  /** ISO 8601 UTC instants. The library applies `dates_are_gmt` and the store time zone. */
  after?: string
  before?: string
  modifiedAfter?: string
  modifiedBefore?: string
  search?: string
  order?: 'asc' | 'desc'
  orderby?: 'date' | 'id' | 'include' | 'title' | 'slug' | 'modified'
  /** Numeric API IDs to include or exclude. */
  include?: number[]
  exclude?: number[]
  /** Numeric API IDs of parent orders. */
  parent?: number[]
  /** Numeric API ID of the customer. */
  customer?: number
  /** Numeric API ID of a product that must appear in the order. */
  product?: number
}

export interface WooEmulateListOrdersResult {
  orders: WooEmulateOrder[]
  totalCount: number
  totalPages?: number
}

export interface WooEmulateTrackingPayload {
  trackingNumber: string
  carrier?: string
  dateShipped?: string
  trackingUrl?: string
}

export interface WooEmulateOAuthAuthorizedPayload {
  appName: string
  userId: string
  scope: string
  returnUrl?: string
  callbackUrl?: string
}

export type WooEmulateStockStatus = 'instock' | 'outofstock' | 'onbackorder'

export interface WooEmulateImage {
  id?: number
  src: string
  name?: string
  alt?: string
}

export interface WooEmulateTermRef {
  id: number
  name: string
  slug: string
}

export interface WooEmulateProductAttribute {
  /** Global attribute ID; 0 or omitted for product-level (custom) attributes. */
  id?: number
  name: string
  options: string[]
  position?: number
  visible?: boolean
  /** True when the attribute defines variations. */
  variation?: boolean
}

export interface WooEmulateProduct {
  id: string | number
  /** Stable, unique, persisted API ID. Required when id is not a positive numeric ID. */
  wooCommerceId?: number
  name: string
  slug?: string
  permalink?: string
  /** Defaults to `variable` when `variationIds` is non-empty, otherwise `simple`. */
  type?: 'simple' | 'variable' | 'grouped' | 'external'
  status?: 'publish' | 'draft' | 'pending' | 'private'
  featured?: boolean
  description?: string
  shortDescription?: string
  sku?: string
  /** Current price. Defaults to the sale price when on sale, otherwise the regular price. */
  priceCents?: number | null
  regularPriceCents?: number | null
  salePriceCents?: number | null
  virtual?: boolean
  downloadable?: boolean
  taxStatus?: 'taxable' | 'shipping' | 'none'
  taxClass?: string
  /** Defaults to true when `stockQuantity` is a number. */
  manageStock?: boolean
  stockQuantity?: number | null
  stockStatus?: WooEmulateStockStatus
  backorders?: 'no' | 'notify' | 'yes'
  weightLb?: number
  dimensionsIn?: { length?: number; width?: number; height?: number }
  shippingClass?: string
  categories?: WooEmulateTermRef[]
  tags?: WooEmulateTermRef[]
  images?: WooEmulateImage[]
  attributes?: WooEmulateProductAttribute[]
  /** Numeric API IDs of the product's variations. */
  variationIds?: number[]
  /** Numeric API ID of the parent (grouped) product. */
  parentId?: number
  totalSales?: number
  menuOrder?: number
  createdAt?: string | Date
  updatedAt?: string | Date
  metadata?: Record<string, unknown>
}

export interface WooEmulateProductVariation {
  id: string | number
  /** Stable, unique, persisted API ID. Required when id is not a positive numeric ID. */
  wooCommerceId?: number
  sku?: string
  description?: string
  permalink?: string
  status?: 'publish' | 'private' | 'draft' | 'pending'
  priceCents?: number | null
  regularPriceCents?: number | null
  salePriceCents?: number | null
  virtual?: boolean
  downloadable?: boolean
  taxStatus?: 'taxable' | 'shipping' | 'none'
  taxClass?: string
  /** `parent` means the parent product manages stock. */
  manageStock?: boolean | 'parent'
  stockQuantity?: number | null
  stockStatus?: WooEmulateStockStatus
  backorders?: 'no' | 'notify' | 'yes'
  weightLb?: number
  dimensionsIn?: { length?: number; width?: number; height?: number }
  shippingClass?: string
  image?: WooEmulateImage | null
  /** Attribute values that define this variation. */
  attributes: Array<{ id?: number; name: string; option: string }>
  menuOrder?: number
  createdAt?: string | Date
  updatedAt?: string | Date
  metadata?: Record<string, unknown>
}

export interface WooEmulateCatalogListParams {
  page: number
  perPage: number
  /** Number of matching items to skip. Authoritative over `page`. */
  offset: number
  order: 'asc' | 'desc'
  orderby: string
  search?: string
  include?: number[]
  exclude?: number[]
  after?: string
  before?: string
  modifiedAfter?: string
  modifiedBefore?: string
  sku?: string[]
  status?: string
  stockStatus?: WooEmulateStockStatus
}

export interface WooEmulateListProductsParams extends WooEmulateCatalogListParams {
  orderby: 'date' | 'id' | 'include' | 'title' | 'slug' | 'price' | 'popularity' | 'rating' | 'modified' | 'menu_order'
  type?: 'simple' | 'variable' | 'grouped' | 'external'
  /** Category API ID. */
  category?: number
  /** Tag API ID. */
  tag?: number
  parent?: number[]
  featured?: boolean
  onSale?: boolean
  minPriceCents?: number
  maxPriceCents?: number
}

export interface WooEmulateListVariationsParams extends WooEmulateCatalogListParams {
  orderby: 'date' | 'id' | 'include' | 'title' | 'slug' | 'modified' | 'menu_order'
}

/** The only product fields the API writes: stock and prices. */
export interface WooEmulateStockPriceChanges {
  manageStock?: boolean
  stockQuantity?: number | null
  stockStatus?: WooEmulateStockStatus
  /** `null` clears the price. */
  regularPriceCents?: number | null
  salePriceCents?: number | null
}

export interface WooEmulateCategory {
  id: number
  name: string
  slug: string
  /** Parent category ID; 0 for top level. */
  parent?: number
  description?: string
  image?: WooEmulateImage | null
  menuOrder?: number
  count?: number
}

export interface WooEmulateTag {
  id: number
  name: string
  slug: string
  description?: string
  count?: number
}

export interface WooEmulateGlobalAttribute {
  id: number
  name: string
  /** Defaults to `pa_` plus a slug of the name. */
  slug?: string
  type?: string
  orderBy?: 'menu_order' | 'name' | 'name_num' | 'id'
  hasArchives?: boolean
}

export interface WooEmulateAttributeTerm {
  id: number
  name: string
  slug: string
  description?: string
  menuOrder?: number
  count?: number
}

/** Optional catalog section. Each hook enables the routes that need it. */
export interface WooEmulateProductAdapter {
  /** Return one page of matching products and the total count. Enables `GET /products`. */
  listProducts(params: WooEmulateListProductsParams): Promise<{
    products: WooEmulateProduct[]
    totalCount: number
    totalPages?: number
  }>
  /** Look up a product by numeric API ID. Enables `GET /products/:id`. */
  getProduct(id: number): Promise<WooEmulateProduct | null>
  /** Enables `GET /products/:id/variations`. */
  listVariations?(
    product: WooEmulateProduct,
    params: WooEmulateListVariationsParams
  ): Promise<{ variations: WooEmulateProductVariation[]; totalCount: number; totalPages?: number }>
  /** Look up a variation by numeric API ID. Enables `GET /products/:id/variations/:variation_id`. */
  getVariation?(product: WooEmulateProduct, variationId: number): Promise<WooEmulateProductVariation | null>
  /**
   * Persist stock and price changes. Enables `PUT/PATCH /products/:id` and `/products/batch`
   * updates. Return the updated product, or nothing to have it re-read.
   */
  updateProduct?(product: WooEmulateProduct, changes: WooEmulateStockPriceChanges): Promise<WooEmulateProduct | void>
  /** Same as `updateProduct`, for variations. */
  updateVariation?(
    product: WooEmulateProduct,
    variation: WooEmulateProductVariation,
    changes: WooEmulateStockPriceChanges
  ): Promise<WooEmulateProductVariation | void>
  /** All categories; the library filters and paginates. Enables `/products/categories`. */
  listCategories?(): Promise<WooEmulateCategory[]>
  /** All tags. Enables `/products/tags`. */
  listTags?(): Promise<WooEmulateTag[]>
  /** All global attributes. Enables `/products/attributes`. */
  listAttributes?(): Promise<WooEmulateGlobalAttribute[]>
  /** All terms of a global attribute. Enables `/products/attributes/:id/terms`. */
  listAttributeTerms?(attributeId: number): Promise<WooEmulateAttributeTerm[]>
}

export interface WooEmulateCustomer {
  id: string | number
  /** Stable, unique, persisted API ID. Required when id is not a positive numeric ID. */
  wooCommerceId?: number
  email: string
  firstName?: string
  lastName?: string
  username?: string
  /** WordPress role. Defaults to `customer`. */
  role?: string
  billing?: Partial<WooEmulateAddress>
  shipping?: Partial<WooEmulateAddress>
  isPayingCustomer?: boolean
  avatarUrl?: string
  /** Reported by v1/v2 routes only. */
  ordersCount?: number
  /** Reported by v1/v2 routes only. */
  totalSpentCents?: number
  createdAt?: string | Date
  updatedAt?: string | Date
  metadata?: Record<string, unknown>
}

export interface WooEmulateListCustomersParams {
  page: number
  perPage: number
  offset: number
  order: 'asc' | 'desc'
  orderby: 'id' | 'include' | 'name' | 'registered_date'
  search?: string
  include?: number[]
  exclude?: number[]
  email?: string
  /** WordPress role filter; omitted for all roles. */
  role?: string
}

export interface WooEmulateCustomerAdapter {
  listCustomers(params: WooEmulateListCustomersParams): Promise<{
    customers: WooEmulateCustomer[]
    totalCount: number
    totalPages?: number
  }>
  /** Look up a customer by numeric API ID. */
  getCustomer(id: number): Promise<WooEmulateCustomer | null>
}

export interface WooEmulateCoupon {
  id: string | number
  /** Stable, unique, persisted API ID. Required when id is not a positive numeric ID. */
  wooCommerceId?: number
  code: string
  discountType: 'percent' | 'fixed_cart' | 'fixed_product'
  /** Percentage for `percent` coupons. */
  percentOff?: number
  /** Amount for fixed coupons. */
  amountCents?: number
  status?: 'publish' | 'draft' | 'pending' | 'private' | 'future'
  description?: string
  expiresAt?: string | Date | null
  usageCount?: number
  usageLimit?: number | null
  usageLimitPerUser?: number | null
  limitUsageToXItems?: number | null
  individualUse?: boolean
  productIds?: number[]
  excludedProductIds?: number[]
  productCategories?: number[]
  excludedProductCategories?: number[]
  excludeSaleItems?: boolean
  freeShipping?: boolean
  minimumAmountCents?: number
  maximumAmountCents?: number
  emailRestrictions?: string[]
  usedBy?: string[]
  createdAt?: string | Date
  updatedAt?: string | Date
  metadata?: Record<string, unknown>
}

export interface WooEmulateListCouponsParams {
  page: number
  perPage: number
  offset: number
  order: 'asc' | 'desc'
  orderby: 'date' | 'id' | 'include' | 'title' | 'slug' | 'modified'
  search?: string
  include?: number[]
  exclude?: number[]
  after?: string
  before?: string
  modifiedAfter?: string
  modifiedBefore?: string
  code?: string
}

export interface WooEmulateCouponAdapter {
  listCoupons(params: WooEmulateListCouponsParams): Promise<{
    coupons: WooEmulateCoupon[]
    totalCount: number
    totalPages?: number
  }>
  /** Look up a coupon by numeric API ID. */
  getCoupon(id: number): Promise<WooEmulateCoupon | null>
}

export interface WooEmulateRefundLineItem {
  /** Line item ID in the refund itself. */
  id?: number
  /** ID of the refunded order line item. */
  refundedItemId?: number
  name: string
  productId?: number
  variationId?: number
  sku?: string
  /** Positive quantity refunded; serialized as negative, as WooCommerce does. */
  quantity: number
  /** Positive amount refunded; serialized as negative. */
  totalCents: number
  taxCents?: number
}

export interface WooEmulateRefund {
  /** Numeric refund ID. */
  id: number
  /** Positive refunded amount. */
  amountCents: number
  reason?: string
  /** Numeric ID of the user who issued the refund; 0 when unknown. */
  refundedBy?: number
  /** True when the money was returned through the payment gateway. */
  refundedPayment?: boolean
  createdAt: string | Date
  lineItems?: WooEmulateRefundLineItem[]
  metadata?: Record<string, unknown>
}

export interface WooEmulateRefundInput {
  amountCents: number
  reason: string
  /** WooCommerce `api_refund`: refund through the payment gateway. Defaults to true. */
  refundPayment: boolean
  /** WooCommerce `api_restock`: restock refunded items. Defaults to true. */
  restockItems: boolean
  lineItems: Array<{ lineItemId: number; quantity: number; refundTotalCents: number; refundTaxCents: number }>
  refundedBy?: number
}

export interface WooEmulateReportsAdapter {
  /** Paying and non-paying customer counts. Enables `/reports/customers/totals`. */
  customersTotals?(): Promise<{ paying: number; nonPaying: number }>
}

export type WooEmulateKeyPermissions = 'read' | 'write' | 'read_write'

export interface WooEmulateApiKey {
  keyId: number
  consumerKey: string
  consumerSecret: string
  permissions: WooEmulateKeyPermissions
  description?: string
  userId?: string | number
}

/** Persistent API keys with per-key permissions. */
export interface WooEmulateApiKeyStore {
  /** Look up a key by consumer key. Secrets are compared in constant time by the library. */
  findApiKey(consumerKey: string): Promise<WooEmulateApiKey | null>
  /**
   * Persist a key minted by one-click authorization and return its numeric ID. When present,
   * each connected app receives its own key with the requested scope.
   */
  createApiKey?(key: Omit<WooEmulateApiKey, 'keyId'> & { appName: string }): Promise<{ keyId: number }>
  /** Delete a key; used when a one-click callback rejects the minted key. */
  deleteApiKey?(keyId: number): Promise<void>
}

export interface WooEmulateOAuth1Config {
  /**
   * Record an OAuth 1.0a nonce. Return false when the consumer key already used this nonce
   * within the last 15 minutes (replay protection). Required to enable OAuth 1.0a.
   */
  useNonce(consumerKey: string, nonce: string, timestamp: number): Promise<boolean>
}

export interface WooEmulateAdapter {
  /**
   * Return a paginated list of orders matching query filters.
   */
  listOrders(params: WooEmulateListOrdersParams): Promise<WooEmulateListOrdersResult>

  /**
   * Retrieve a single order by ID or order number.
   */
  getOrder(idOrNumber: string | number): Promise<WooEmulateOrder | null>

  /** Resolve a persisted API ID to its original order. Required for mapped string IDs. */
  getOrderByWooCommerceId?(id: number): Promise<WooEmulateOrder | null>

  /**
   * Optional hook when an order status is updated by a client (e.g. mark completed).
   */
  updateOrderStatus?(orderId: string | number, status: WooEmulateOrderStatus): Promise<void>

  /**
   * Optional hook when a compatible client pushes a tracking number.
   */
  onShipmentTrackingCreated?(
    orderId: string | number,
    tracking: WooEmulateTrackingPayload
  ): Promise<{ id: string | number }>

  /**
   * Optional hook called after successful 1-click OAuth connection.
   */
  onOAuthAuthorized?(payload: WooEmulateOAuthAuthorizedPayload): Promise<void>

  /** Lists an order's notes. Enables `GET /orders/:id/notes`. Receives the original order ID. */
  listOrderNotes?(
    orderId: string | number,
    filter: { type: 'any' | 'customer' | 'internal' }
  ): Promise<WooEmulateOrderNote[]>

  /** Persists a note. Enables `POST /orders/:id/notes`. Receives the original order ID. */
  createOrderNote?(orderId: string | number, note: WooEmulateOrderNoteInput): Promise<WooEmulateOrderNote>

  /** Deletes a note. Enables `DELETE /orders/:id/notes/:note_id`. */
  deleteOrderNote?(orderId: string | number, noteId: number): Promise<void>

  /** Optional product catalog. Enables `/products` and related routes. */
  products?: WooEmulateProductAdapter

  /** Optional customers. Enables `/customers`. */
  customers?: WooEmulateCustomerAdapter

  /** Optional coupons. Enables `/coupons`. */
  coupons?: WooEmulateCouponAdapter

  /** Lists an order's refunds. Enables `GET /orders/:id/refunds`. Receives the original order ID. */
  listOrderRefunds?(orderId: string | number): Promise<WooEmulateRefund[]>

  /**
   * Creates a refund. Enables `POST /orders/:id/refunds`. This can move money: the host decides
   * whether `refundPayment` returns funds through its payment gateway.
   */
  createOrderRefund?(orderId: string | number, refund: WooEmulateRefundInput): Promise<WooEmulateRefund>

  /** Optional report data the library cannot compute from other hooks. */
  reports?: WooEmulateReportsAdapter
}

export interface WooEmulateStoreConfig {
  name: string
  description?: string
  url: string
  currency?: string
  /** Currency symbol position. Defaults to `left`. */
  currencyPosition?: 'left' | 'right' | 'left_space' | 'right_space'
  thousandSeparator?: string
  decimalSeparator?: string
  /** Price decimals. Defaults to 2. */
  decimals?: number
  /** Store address reported by `/settings/general`. */
  address?: {
    address1?: string
    address2?: string
    city?: string
    state?: string
    postalCode?: string
    country?: string
  }
  /** Whether the store calculates taxes (`woocommerce_calc_taxes`). Defaults to false. */
  calcTaxes?: boolean
  version?: string
  /** IANA time zone for plain `date_*` fields and date filters. Defaults to UTC. */
  timezone?: string
}

export interface WooEmulateAuthConfig {
  consumerKey: string
  consumerSecret: string
  /** Defaults to `read_write`. */
  permissions?: WooEmulateKeyPermissions
  /** Reported as `key_id` to one-click callbacks. Defaults to 1. */
  keyId?: number
}

export interface WooEmulateAuthResult {
  authenticated: boolean
  error?: string
  status?: number
}

export interface WooEmulateOAuthConfig {
  /** Exact HTTPS callback URLs trusted to receive the configured API credentials. */
  allowedCallbackUrls: string[]
  /** Exact HTTP(S) URLs trusted to receive the connection result. */
  allowedReturnUrls: string[]
  /** Callback request timeout in milliseconds. Defaults to 30000. */
  callbackTimeoutMs?: number
  /**
   * Optional login page for owners who are not signed in. When `authorize` returns false on the
   * consent GET, the owner is redirected here with the authorization URL to return to.
   */
  loginUrl?(returnTo: string): string
  /**
   * Authenticate the current store owner and check their permission to connect apps.
   * Called for both the consent page and approval POST. Fail closed when unauthenticated.
   * The handler also requires a same-origin approval POST to prevent cross-site requests.
   */
  authorize(request: Request, connection: WooEmulateOAuthAuthorizedPayload): Promise<boolean>
}

export type WooEmulateWebhookStatus = 'active' | 'paused' | 'disabled'
export type WooEmulateWebhookApiVersion = 'wp_api_v1' | 'wp_api_v2' | 'wp_api_v3'

export interface WooEmulateWebhook {
  /** Numeric webhook ID assigned by the store. */
  id: number
  name: string
  status: WooEmulateWebhookStatus
  /** For example `order.updated` or `action.woocommerce_order_status_processing`. */
  topic: string
  deliveryUrl: string
  /** HMAC-SHA256 signing secret. Never returned by the API. */
  secret: string
  /** Payload schema, taken from the namespace the webhook was created through. */
  apiVersion: WooEmulateWebhookApiVersion
  /** Consecutive failed deliveries. */
  failureCount: number
  createdAt: string | Date
  updatedAt?: string | Date
}

export type WooEmulateWebhookInput = Omit<WooEmulateWebhook, 'id' | 'createdAt' | 'updatedAt'>

/** Persistent webhook storage. Serverless hosts cannot keep webhooks in memory. */
export interface WooEmulateWebhookStore {
  listWebhooks(): Promise<WooEmulateWebhook[]>
  getWebhook(id: number): Promise<WooEmulateWebhook | null>
  createWebhook(input: WooEmulateWebhookInput): Promise<WooEmulateWebhook>
  updateWebhook(id: number, changes: Partial<WooEmulateWebhookInput>): Promise<WooEmulateWebhook>
  deleteWebhook(id: number): Promise<void>
}

export interface WooEmulateWebhookDelivery {
  webhookId: number
  deliveryId: string
  topic: string
  /** HTTP status from the delivery URL, or null when the request failed or was blocked. */
  status: number | null
  success: boolean
  error?: string
  durationMs: number
}

export interface WooEmulateWebhooksConfig {
  store: WooEmulateWebhookStore
  /**
   * Decides whether a delivery URL may receive webhooks. Replaces the default policy, which
   * requires HTTPS and rejects localhost, private, link-local, and other internal addresses.
   * The default cannot detect public hostnames that resolve to private addresses.
   */
  validateDeliveryUrl?(url: URL): boolean | Promise<boolean>
  /** Delivery timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number
  /**
   * A webhook is disabled when a delivery fails after this many recorded consecutive failures.
   * Defaults to 5, as in WooCommerce.
   */
  maxDeliveryFailures?: number
  /** Fetch implementation used for deliveries and pings. Defaults to the global fetch. */
  fetch?: typeof fetch
  /** Observes each delivery attempt. Errors thrown here are ignored. */
  onDelivery?(delivery: WooEmulateWebhookDelivery): void | Promise<void>
}

export interface WooEmulateRequestEvent {
  method: string
  path: string
  /** Query parameter names only. Values, including credentials, are never reported. */
  queryParams: string[]
  status: number
  /** WordPress-style route pattern that handled the request, when one matched. */
  route?: string
  durationMs: number
}

export interface WooEmulateRequestContext {
  /** Runs background work, such as webhook pings, after the response (e.g. Workers `ctx.waitUntil`). */
  waitUntil?(promise: Promise<unknown>): void
}

export interface WooEmulateConfig {
  store: WooEmulateStoreConfig
  /** A single key pair or a custom resolver. Optional when `apiKeys` is configured. */
  auth?:
    | WooEmulateAuthConfig
    | ((request: Request) => Promise<WooEmulateAuthConfig | WooEmulateAuthResult>)
  /** Multiple keys with per-key permissions; checked before `auth`. */
  apiKeys?: WooEmulateApiKeyStore
  /** Enables one-legged OAuth 1.0a for clients that use plain-HTTP store URLs. Off by default. */
  oauth1?: WooEmulateOAuth1Config
  adapter: WooEmulateAdapter
  /** One-click authorization is disabled unless explicitly configured. */
  oauth?: WooEmulateOAuthConfig
  /** Enables the `/webhooks` API and `emulator.webhooks.dispatch`. */
  webhooks?: WooEmulateWebhooksConfig
  basePath?: string
  cors?: boolean | { origins?: string[]; allowHeaders?: string[] }
  /**
   * Read-only collection routes (for example `products/categories`) that return an empty list
   * when the adapter does not implement them. Some services call these as connection checks.
   */
  emptyCollections?: string[]
  /**
   * When true, notes created through the API are scanned with `parseTrackingFromNote` and any
   * tracking found is passed to `onShipmentTrackingCreated`. Services such as Pirate Ship and
   * ShippingEasy write tracking only as order notes. Defaults to false.
   */
  trackingFromNotes?: boolean
  /** Observes each API request after it is handled. Errors thrown here are ignored. */
  onRequest?(event: WooEmulateRequestEvent): void | Promise<void>
}
