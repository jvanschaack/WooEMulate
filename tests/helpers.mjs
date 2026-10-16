// Shared fixtures for the conformance suites. Tests run against the built package in dist/.
export const origin = 'https://store.example'
export const auth = { consumerKey: 'ck_fixture', consumerSecret: 'cs_fixture' }
export const basic = 'Basic ' + btoa(`${auth.consumerKey}:${auth.consumerSecret}`)

export function makeOrder(n, overrides = {}) {
  return {
    id: `ord_${n}`,
    wooCommerceId: 1000 + n,
    orderNumber: `STORE-${n}`,
    status: 'processing',
    createdAt: new Date(Date.UTC(2026, 0, 1) + n * 3_600_000).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 0, 1) + n * 3_600_000 + 60_000).toISOString(),
    totalCents: 1000 + n,
    customer: { email: `buyer${n}@example.com` },
    shippingAddress: { firstName: 'Example', lastName: `Buyer ${n}`, address1: '1 Example St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
    items: [{ name: 'Example item', sku: 'SKU-1', quantity: 1, unitPriceCents: 1000 + n }],
    ...overrides,
  }
}

/** An adapter that honors the documented list contract, including offset and modified filters. */
export function memoryAdapter(orders) {
  const calls = []
  const apiId = (order) => order.wooCommerceId ?? Number(order.id)
  return {
    calls,
    adapter: {
      async listOrders(params) {
        calls.push(params)
        const statuses = params.status ? [].concat(params.status) : []
        const time = (value) => new Date(value).getTime()
        let rows = orders.filter((order) => {
          if (statuses.length && !statuses.includes(order.status)) return false
          if (params.after && time(order.createdAt) <= time(params.after)) return false
          if (params.before && time(order.createdAt) >= time(params.before)) return false
          if (params.modifiedAfter && time(order.updatedAt ?? order.createdAt) <= time(params.modifiedAfter)) return false
          if (params.modifiedBefore && time(order.updatedAt ?? order.createdAt) >= time(params.modifiedBefore)) return false
          if (params.include && !params.include.includes(apiId(order))) return false
          if (params.exclude && params.exclude.includes(apiId(order))) return false
          return true
        })
        const key = params.orderby === 'id' ? apiId : params.orderby === 'modified'
          ? (order) => time(order.updatedAt ?? order.createdAt)
          : (order) => time(order.createdAt)
        rows = [...rows].sort((a, b) => (key(a) - key(b)) * (params.order === 'asc' ? 1 : -1))
        return { orders: rows.slice(params.offset, params.offset + params.perPage), totalCount: rows.length }
      },
      async getOrder(id) {
        return orders.find((order) => order.id === id || order.orderNumber === id) || null
      },
      async getOrderByWooCommerceId(id) {
        return orders.find((order) => apiId(order) === id) || null
      },
      async updateOrderStatus(id, status) {
        const order = orders.find((row) => row.id === id)
        order.status = status
        order.updatedAt = new Date().toISOString()
      },
      async onShipmentTrackingCreated(id, tracking) {
        orders.find((row) => row.id === id).tracking = { id: 7, ...tracking }
        return { id: 7 }
      },
    },
  }
}

export function request(emulator, path, { method = 'GET', body, headers = {}, query = '' } = {}) {
  const url = `${origin}/wp-json${path}${query ? (path.includes('?') ? '&' : '?') + query : ''}`
  return emulator.handleRequest(new Request(url, {
    method,
    headers: { Authorization: basic, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
}
