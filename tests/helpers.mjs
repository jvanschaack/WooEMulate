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

/** In-memory webhook store for tests. Real deployments need persistent storage. */
export function memoryWebhookStore() {
  const rows = new Map()
  let nextId = 1
  return {
    rows,
    async listWebhooks() { return [...rows.values()].map((row) => ({ ...row })) },
    async getWebhook(id) { return rows.has(id) ? { ...rows.get(id) } : null },
    async createWebhook(input) {
      const row = { ...input, id: nextId++, createdAt: new Date().toISOString() }
      rows.set(row.id, row)
      return { ...row }
    },
    async updateWebhook(id, changes) {
      const row = { ...rows.get(id), ...changes, updatedAt: new Date().toISOString() }
      rows.set(id, row)
      return { ...row }
    },
    async deleteWebhook(id) { rows.delete(id) },
  }
}

/** Records outgoing requests and answers each with the configured status. */
export function recordingFetch(status = 200) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init, headers: new Headers(init.headers), body: init.body })
    return new Response('ok', { status: typeof status === 'function' ? status(url, init) : status })
  }
  return { calls, fetch }
}

/** In-memory catalog implementing the product adapter contract. */
export function memoryCatalog() {
  const products = [
    {
      id: 'prod_tee', wooCommerceId: 300, name: 'Logo Tee', sku: 'TEE', type: 'variable',
      regularPriceCents: 2000, weightLb: 0.5, dimensionsIn: { length: 10, width: 8, height: 1 },
      categories: [{ id: 5, name: 'Apparel', slug: 'apparel' }],
      images: [{ id: 50, src: 'https://cdn.example/tee.jpg', alt: 'Tee' }],
      attributes: [{ id: 1, name: 'Size', options: ['M', 'L'], variation: true }],
      variationIds: [301, 302], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-05T00:00:00Z',
    },
    {
      id: 'prod_mug', wooCommerceId: 400, name: 'Coffee Mug', sku: 'MUG', regularPriceCents: 1500, salePriceCents: 1200,
      manageStock: true, stockQuantity: 0, weightLb: 1.25, categories: [{ id: 6, name: 'Kitchen', slug: 'kitchen' }],
      createdAt: '2026-01-02T00:00:00Z',
    },
  ]
  const variations = {
    300: [
      { id: 'var_m', wooCommerceId: 301, sku: 'TEE-M', regularPriceCents: 2000, manageStock: true, stockQuantity: 4, attributes: [{ id: 1, name: 'Size', option: 'M' }] },
      { id: 'var_l', wooCommerceId: 302, sku: 'TEE-L', regularPriceCents: 2200, manageStock: true, stockQuantity: 0, backorders: 'notify', attributes: [{ id: 1, name: 'Size', option: 'L' }], image: { id: 51, src: 'https://cdn.example/tee-l.jpg' } },
    ],
  }
  const calls = { list: [], updates: [] }
  const catalog = {
    async listProducts(params) {
      calls.list.push(params)
      let rows = products
      if (params.sku) rows = rows.filter((row) => params.sku.includes(row.sku))
      if (params.include) rows = rows.filter((row) => params.include.includes(row.wooCommerceId))
      return { products: rows.slice(params.offset, params.offset + params.perPage), totalCount: rows.length }
    },
    async getProduct(id) { return products.find((row) => row.wooCommerceId === id) || null },
    async listVariations(product, params) {
      const rows = variations[product.wooCommerceId] || []
      return { variations: rows.slice(params.offset, params.offset + params.perPage), totalCount: rows.length }
    },
    async getVariation(product, id) { return (variations[product.wooCommerceId] || []).find((row) => row.wooCommerceId === id) || null },
    async updateProduct(product, changes) {
      calls.updates.push({ product: product.id, changes })
      Object.assign(product, changes)
    },
    async updateVariation(product, variation, changes) {
      calls.updates.push({ product: product.id, variation: variation.id, changes })
      Object.assign(variation, changes)
      return variation
    },
    async listCategories() {
      return [
        { id: 5, name: 'Apparel', slug: 'apparel', count: 1 },
        { id: 6, name: 'Kitchen', slug: 'kitchen', count: 1 },
        { id: 7, name: 'Hats', slug: 'hats', parent: 5, count: 0 },
      ]
    },
    async listTags() { return [{ id: 9, name: 'Sale', slug: 'sale', count: 1 }] },
    async listAttributes() { return [{ id: 1, name: 'Size' }] },
    async listAttributeTerms(attributeId) {
      return attributeId === 1 ? [{ id: 11, name: 'M', slug: 'm' }, { id: 12, name: 'L', slug: 'l' }] : []
    },
  }
  return { catalog, products, variations, calls }
}
