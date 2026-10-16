import { getWcNumericId } from './helpers.js'
import type { WooEmulateConfig, WooEmulateOrder } from './types.js'

/** Resolve the API ID, then verify the adapter returned the same order identity. */
export async function findOrderByApiId(
  config: WooEmulateConfig,
  idParam: string
): Promise<WooEmulateOrder | null> {
  let apiId: number
  try {
    apiId = getWcNumericId(idParam)
  } catch {
    return null
  }

  const order = config.adapter.getOrderByWooCommerceId
    ? await config.adapter.getOrderByWooCommerceId(apiId)
    : await config.adapter.getOrder(apiId) ?? await config.adapter.getOrder(String(apiId))

  if (!order) return null
  try {
    return getWcNumericId(order.wooCommerceId ?? order.id) === apiId ? order : null
  } catch {
    return null
  }
}

/**
 * Resolves a numeric API ID through an adapter lookup and verifies the returned record carries
 * the same API ID, so a faulty lookup can never expose or modify another record.
 */
export async function findByApiId<T extends { id: string | number; wooCommerceId?: number }>(
  idParam: string,
  lookup: (id: number) => Promise<T | null>
): Promise<T | null> {
  let apiId: number
  try {
    apiId = getWcNumericId(idParam)
  } catch {
    return null
  }
  const item = await lookup(apiId)
  if (!item) return null
  try {
    return getWcNumericId(item.wooCommerceId ?? item.id) === apiId ? item : null
  } catch {
    return null
  }
}
