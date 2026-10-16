/**
 * Demo adapter only. Copy into your app as lib/store-adapter.ts and rename demoAdapter
 * to storeAdapter. Replace in-memory operations with persistent storage for real orders.
 */
import type { WooEmulateAdapter, WooEmulateOrder, WooEmulateOrderNote } from 'wooemulate'

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

const notes = new Map<string | number, WooEmulateOrderNote[]>()
let nextNoteId = 1

function requireOrder(id: string | number): WooEmulateOrder {
  const order = orders.find((item) => item.id === id)
  if (!order) throw new Error('Order not found')
  return order
}

export const demoAdapter: WooEmulateAdapter = {
  async listOrders({
    status, page = 1, perPage = 10, offset = (page - 1) * perPage, after, before,
    modifiedAfter, modifiedBefore, include, exclude, search, order = 'desc', orderby = 'date',
  }) {
    const statuses = status ? (Array.isArray(status) ? status : [status]) : []
    const matching = orders.filter((item) => {
      const created = new Date(item.createdAt).getTime()
      const modified = new Date(item.updatedAt ?? item.createdAt).getTime()
      if (statuses.length && !statuses.includes(item.status)) return false
      if (after && created <= Date.parse(after)) return false
      if (before && created >= Date.parse(before)) return false
      if (modifiedAfter && modified <= Date.parse(modifiedAfter)) return false
      if (modifiedBefore && modified >= Date.parse(modifiedBefore)) return false
      if (include && !include.includes(item.wooCommerceId!)) return false
      if (exclude && exclude.includes(item.wooCommerceId!)) return false
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
          : orderby === 'modified'
            ? new Date(a.updatedAt ?? a.createdAt).getTime() - new Date(b.updatedAt ?? b.createdAt).getTime()
            : new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      return order === 'asc' ? comparison : -comparison
    })
    // `offset` takes precedence over `page`; clients such as Airbyte page by offset.
    return {
      orders: matching.slice(offset, offset + perPage),
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
  async listOrderNotes(id) {
    return notes.get(id) ?? []
  },
  async createOrderNote(id, { note, customerNote }) {
    requireOrder(id)
    // A customer note would be emailed by WooCommerce; send one here if your store does.
    const created = { id: nextNoteId++, note, customerNote, createdAt: new Date().toISOString() }
    notes.set(id, [...(notes.get(id) ?? []), created])
    return created
  },
}
