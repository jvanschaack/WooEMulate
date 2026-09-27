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
  page?: number
  perPage?: number
  after?: string
  before?: string
  search?: string
  order?: 'asc' | 'desc'
  orderby?: 'date' | 'id' | 'title'
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

  /**
   * Optional hook when an order status is updated by a client (e.g. mark completed).
   */
  updateOrderStatus?(orderId: string | number, status: WooEmulateOrderStatus): Promise<void>

  /**
   * Optional hook when a shipping client pushes a tracking number (e.g. Pirate Ship or ShipStation).
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

export interface WooEmulateConfig {
  store: WooEmulateStoreConfig
  auth:
    | WooEmulateAuthConfig
    | ((request: Request) => Promise<WooEmulateAuthConfig | WooEmulateAuthResult>)
  adapter: WooEmulateAdapter
  basePath?: string
  cors?: boolean | { origins?: string[]; allowHeaders?: string[] }
}
