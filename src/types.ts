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
  totalPriceCents?: number
  weightLb?: number
  dimensionsIn?: {
    length?: number
    width?: number
    height?: number
  }
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
  orderNumber: string
  status: WooEmulateOrderStatus | string
  createdAt: string | Date
  updatedAt?: string | Date
  totalCents: number
  subtotalCents?: number
  shippingCents?: number
  taxCents?: number
  discountCents?: number
  currency?: string
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
  metadata?: Record<string, any>
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
}

export interface WooEmulateStoreConfig {
  name: string
  description?: string
  url: string
  currency?: string
  version?: string
  /** IANA time zone for plain `date_*` fields and date filters. Defaults to UTC. */
  timezone?: string
}

export interface WooEmulateAuthConfig {
  consumerKey: string
  consumerSecret: string
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
  auth:
    | WooEmulateAuthConfig
    | ((request: Request) => Promise<WooEmulateAuthConfig | WooEmulateAuthResult>)
  adapter: WooEmulateAdapter
  /** One-click authorization is disabled unless explicitly configured. */
  oauth?: WooEmulateOAuthConfig
  basePath?: string
  cors?: boolean | { origins?: string[]; allowHeaders?: string[] }
  /**
   * Read-only collection routes (for example `products/categories`) that return an empty list
   * when the adapter does not implement them. Some services call these as connection checks.
   */
  emptyCollections?: string[]
  /** Observes each API request after it is handled. Errors thrown here are ignored. */
  onRequest?(event: WooEmulateRequestEvent): void | Promise<void>
}
