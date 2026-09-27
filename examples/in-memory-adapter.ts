/**
 * Demo adapter only. Copy into your app as lib/store-adapter.ts and rename demoAdapter
 * to storeAdapter. Replace in-memory operations with persistent storage for real orders.
 */
import type { WooEmulateAdapter, WooEmulateOrder } from 'wooemulate'

const orders: WooEmulateOrder[] = [{
  id: 'ord_demo',
  wooCommerceId: 1001,
  orderNumber: 'DEMO-1001',
  status: 'processing',
  createdAt: '2026-09-27T12:00:00Z',
  totalCents: 2500,
  customer: { email: 'alex@example.com' },
  shippingAddress: {
    firstName: 'Alex', address1: '123 Example Street',
    city: 'Austin', state: 'TX', postalCode: '78701', country: 'US',
  },
  items: [{ name: 'Example product', quantity: 1, unitPriceCents: 2500 }],
}]

function requireOrder(id: string | number): WooEmulateOrder {
  const order = orders.find((item) => item.id === id)
  if (!order) throw new Error('Order not found')
  return order
}

export const demoAdapter: WooEmulateAdapter = {
  async listOrders({ status, page = 1, perPage = 50, after, before, search, order = 'desc', orderby = 'date' }) {
    const statuses = status ? (Array.isArray(status) ? status : [status]) : []
    const matching = orders.filter((item) => {
      const created = new Date(item.createdAt).getTime()
      if (statuses.length && !statuses.includes(item.status)) return false
      if (after && created <= Date.parse(after)) return false
      if (before && created >= Date.parse(before)) return false
      if (search && ![item.orderNumber, item.customer?.email || ''].some(
        (value) => value.toLowerCase().includes(search.toLowerCase())
      )) return false
      return true
    })
    matching.sort((a, b) => {
      const comparison = orderby === 'id'
        ? a.wooCommerceId! - b.wooCommerceId!
        : orderby === 'title'
          ? a.orderNumber.localeCompare(b.orderNumber)
          : new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      return order === 'asc' ? comparison : -comparison
    })
    return {
      orders: matching.slice((page - 1) * perPage, page * perPage),
      totalCount: matching.length,
    }
  },
  async getOrder(idOrNumber) {
    return orders.find((item) => item.id === idOrNumber || item.orderNumber === String(idOrNumber)) || null
  },
  async getOrderByWooCommerceId(id) {
    return orders.find((item) => item.wooCommerceId === id) || null
  },
  async updateOrderStatus(id, status) {
    const order = requireOrder(id)
    order.status = status
    order.updatedAt = new Date().toISOString()
  },
  async onShipmentTrackingCreated(id, tracking) {
    // The demo keeps one tracking record per order, so repeated requests replace it.
    requireOrder(id).tracking = { id: 1, ...tracking }
    return { id: 1 }
  },
}
