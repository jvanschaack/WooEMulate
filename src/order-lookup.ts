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

  if (!order || getWcNumericId(order.wooCommerceId ?? order.id) !== apiId) return null
  return order
}
