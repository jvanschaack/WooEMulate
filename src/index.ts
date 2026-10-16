/**
 * WooEMulate
 * Turn any custom, headless, or serverless store into a WooCommerce REST API v3 facade.
 *
 * @license MIT
 */

export { createWooEmulate, type WooEmulateInstance } from './router.js'
export { serializeWcOrder, serializeWcOrderNote, type WcSerializeOptions } from './serializer.js'
export { parseTrackingFromNote } from './tracking-notes.js'
export { authenticateRequest, wcErrorResponse } from './auth.js'
export {
  getWcNumericId,
  splitName,
  mapToWcStatus,
  mapFromWcStatus,
  detectCarrier,
  getTrackingUrl,
  formatCurrency,
  currencySymbol,
} from './helpers.js'

export type {
  WooEmulateConfig,
  WooEmulateStoreConfig,
  WooEmulateAuthConfig,
  WooEmulateAuthResult,
  WooEmulateOAuthConfig,
  WooEmulateAdapter,
  WooEmulateOrder,
  WooEmulateOrderItem,
  WooEmulateAddress,
  WooEmulateTracking,
  WooEmulateTrackingPayload,
  WooEmulateListOrdersParams,
  WooEmulateListOrdersResult,
  WooEmulateOrderStatus,
  WooEmulateOAuthAuthorizedPayload,
  WooEmulateRequestEvent,
  WooEmulateOrderNote,
  WooEmulateOrderNoteInput,
  WooEmulateTaxLine,
  WooEmulateShippingLine,
  WooEmulateFeeLine,
  WooEmulateCouponLine,
  WooEmulateRefundSummary,
  WooEmulateRequestContext,
} from './types.js'
