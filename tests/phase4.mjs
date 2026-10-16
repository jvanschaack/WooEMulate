import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createWooEmulate } from '../dist/index.js'
import { auth, makeOrder, memoryAdapter, memoryCatalog, memoryWebhookStore, origin, recordingFetch, request } from './helpers.mjs'

const customers = [
  { id: 'cus_b', wooCommerceId: 21, email: 'bea@example.com', firstName: 'Bea', lastName: 'Lee', isPayingCustomer: true, ordersCount: 3, totalSpentCents: 4500,
    billing: { firstName: 'Bea', lastName: 'Lee', address1: '1 Main', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US', email: 'bea@example.com' },
    shipping: { firstName: 'Bea', lastName: 'Lee', address1: '1 Main', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
    createdAt: '2025-12-01T00:00:00Z' },
  { id: 'cus_a', wooCommerceId: 22, email: 'al@example.com', firstName: 'Al', createdAt: '2025-12-02T00:00:00Z' },
]
const coupons = [
  { id: 'cp_1', wooCommerceId: 31, code: 'SAVE15', discountType: 'percent', percentOff: 15, usageCount: 2, createdAt: '2026-01-01T00:00:00Z' },
  { id: 'cp_2', wooCommerceId: 32, code: 'five', discountType: 'fixed_cart', amountCents: 500, minimumAmountCents: 2000, expiresAt: '2026-12-31T00:00:00Z' },
]

function setup(extra = {}, adapterExtra = {}) {
  const orders = [makeOrder(1, { totalCents: 5000, items: [{ id: 1, name: 'Mug', productId: 400, quantity: 2, unitPriceCents: 2500 }] })]
  const { adapter } = memoryAdapter(orders)
  const calls = { customers: [], coupons: [], refunds: [] }
  const refunds = [{ id: 81, amountCents: 1000, reason: 'Damaged', createdAt: '2026-01-03T00:00:00Z', refundedPayment: true,
    lineItems: [{ refundedItemId: 1, name: 'Mug', productId: 400, quantity: 1, totalCents: 1000 }] }]
  Object.assign(adapter, {
    customers: {
      async listCustomers(params) { calls.customers.push(params); return { customers, totalCount: customers.length } },
      async getCustomer(id) { return customers.find((row) => row.wooCommerceId === id) || null },
    },
    coupons: {
      async listCoupons(params) { calls.coupons.push(params); return { coupons, totalCount: coupons.length } },
      async getCoupon(id) { return coupons.find((row) => row.wooCommerceId === id) || null },
    },
    async listOrderRefunds(orderId) { return orderId === 'ord_1' ? refunds : [] },
    async createOrderRefund(orderId, input) {
      calls.refunds.push({ orderId, input })
      const refund = { id: 90 + refunds.length, amountCents: input.amountCents, reason: input.reason, createdAt: '2026-01-04T00:00:00Z', refundedPayment: input.refundPayment }
      refunds.push(refund)
      return refund
    },
    ...adapterExtra,
  })
  const emulator = createWooEmulate({ store: { name: 'Example', url: origin }, auth, adapter, ...extra })
  return { emulator, calls, orders, refunds, adapter }
}

test('customers list, filter, and serialize per API version', async () => {
  const { emulator, calls } = setup()
  const response = await request(emulator, '/wc/v3/customers', { query: 'email=bea@example.com&role=customer&search=bea' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-wp-total'), '2')
  const params = calls.customers.at(-1)
  assert.equal(params.email, 'bea@example.com')
  assert.equal(params.role, 'customer')
  assert.equal(params.orderby, 'name')
  assert.equal(params.order, 'asc')
  const [bea] = await response.json()
  assert.equal(bea.id, 21)
  assert.equal(bea.role, 'customer')
  assert.equal(bea.is_paying_customer, true)
  assert.equal(bea.billing.email, 'bea@example.com')
  assert.equal('email' in bea.shipping, false)
  assert.equal(bea.orders_count, undefined)
  const v2 = await (await request(emulator, '/wc/v2/customers/21')).json()
  assert.equal(v2.orders_count, 3)
  assert.equal(v2.total_spent, '45.00')
  assert.equal((await request(emulator, '/wc/v3/customers/99')).status, 404)
  assert.equal((await request(emulator, '/wc/v3/customers', { query: 'email=not-an-email' })).status, 400)
  await request(emulator, '/wc/v3/customers', { query: 'role=all' })
  assert.equal(calls.customers.at(-1).role, undefined)
})

test('coupons list and serialize amounts by discount type', async () => {
  const { emulator, calls } = setup()
  const list = await (await request(emulator, '/wc/v3/coupons', { query: 'code=save15' })).json()
  assert.equal(calls.coupons.at(-1).code, 'save15')
  assert.equal(list[0].code, 'save15')
  assert.equal(list[0].amount, '15.00')
  assert.equal(list[0].discount_type, 'percent')
  assert.equal(list[1].amount, '5.00')
  assert.equal(list[1].minimum_amount, '20.00')
  assert.equal(list[1].date_expires_gmt, '2026-12-31T00:00:00')
  assert.equal((await (await request(emulator, '/wc/v3/coupons/32')).json()).code, 'five')
  assert.equal((await request(emulator, '/wc/v3/coupons/33')).status, 404)
})

test('customer, coupon, and refund routes need their adapter hooks', async () => {
  const { adapter } = memoryAdapter([makeOrder(1)])
  const emulator = createWooEmulate({ store: { name: 'Example', url: origin }, auth, adapter })
  for (const path of ['/customers', '/coupons', '/orders/1001/refunds']) {
    assert.equal((await request(emulator, `/wc/v3${path}`)).status, 404, path)
  }
  const { emulator: readOnly } = setup({}, { createOrderRefund: undefined })
  assert.equal((await request(readOnly, '/wc/v3/orders/1001/refunds', { method: 'POST', body: { amount: '1.00' } })).status, 404)
})

test('refunds list and read with negative line totals', async () => {
  const { emulator } = setup()
  const list = await request(emulator, '/wc/v3/orders/1001/refunds')
  assert.equal(list.headers.get('x-wp-total'), '1')
  const [refund] = await list.json()
  assert.equal(refund.amount, '10.00')
  assert.equal(refund.reason, 'Damaged')
  assert.equal(refund.refunded_payment, true)
  assert.equal(refund.line_items[0].quantity, -1)
  assert.equal(refund.line_items[0].total, '-10.00')
  assert.deepEqual(refund.line_items[0].meta_data, [{ key: '_refunded_item_id', value: '1' }])
  assert.equal(refund._links.up[0].href, `${origin}/wp-json/wc/v3/orders/1001`)
  assert.equal((await request(emulator, '/wc/v3/orders/1001/refunds/81')).status, 200)
  assert.equal((await request(emulator, '/wc/v3/orders/1001/refunds/82')).status, 404)
})

test('creating refunds validates amounts and line items before calling the hook', async () => {
  const { emulator, calls } = setup()
  const created = await request(emulator, '/wc/v3/orders/1001/refunds', {
    method: 'POST',
    body: { reason: 'Broken', api_refund: false, line_items: [{ id: 1, quantity: 1, refund_total: '20.00', refund_tax: [{ id: 1, refund_total: '1.50' }] }] },
  })
  assert.equal(created.status, 201)
  assert.match(created.headers.get('location'), /\/orders\/1001\/refunds\/\d+$/)
  assert.deepEqual(calls.refunds[0], {
    orderId: 'ord_1',
    input: { amountCents: 2150, reason: 'Broken', refundPayment: false, restockItems: true, lineItems: [{ lineItemId: 1, quantity: 1, refundTotalCents: 2000, refundTaxCents: 150 }] },
  })
  assert.equal((await created.json()).amount, '21.50')

  const cases = [
    [{ amount: '0' }, 'woocommerce_rest_cannot_create_order_refund'],
    [{ amount: '30.00' }, 'woocommerce_rest_cannot_create_order_refund'], // 50.00 total - 10.00 - 21.50 already refunded
    [{ amount: 'lots' }, 'rest_invalid_param'],
    [{ line_items: [{ id: 9, quantity: 1, refund_total: '1.00' }] }, 'rest_invalid_param'],
    [{ line_items: [{ id: 1, quantity: 5, refund_total: '1.00' }] }, 'rest_invalid_param'],
  ]
  for (const [body, code] of cases) {
    const response = await request(emulator, '/wc/v3/orders/1001/refunds', { method: 'POST', body })
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.equal((await response.json()).code, code)
  }
  assert.equal(calls.refunds.length, 1)
})

test('settings expose store configuration as WooCommerce settings', async () => {
  const { emulator } = setup({
    store: { name: 'Example', url: origin, currency: 'EUR', currencyPosition: 'right_space', decimals: 2, address: { address1: '1 Rue', city: 'Paris', postalCode: '75001', country: 'FR' } },
  })
  const groups = await (await request(emulator, '/wc/v3/settings')).json()
  assert.deepEqual(groups.map((group) => group.id), ['general', 'products'])
  const general = Object.fromEntries((await (await request(emulator, '/wc/v3/settings/general')).json()).map((row) => [row.id, row.value]))
  assert.equal(general.woocommerce_currency, 'EUR')
  assert.equal(general.woocommerce_currency_pos, 'right_space')
  assert.equal(general.woocommerce_default_country, 'FR')
  assert.equal(general.woocommerce_store_city, 'Paris')
  const weight = await (await request(emulator, '/wc/v3/settings/products/woocommerce_weight_unit')).json()
  assert.equal(weight.value, 'lbs')
  assert.equal((await request(emulator, '/wc/v3/settings/shipping')).status, 404)
  assert.equal((await request(emulator, '/wc/v3/settings/general/nope')).status, 404)
})

test('sales and top-seller reports aggregate real order data', async () => {
  const day = (d, h = 12) => new Date(Date.UTC(2026, 2, d, h)).toISOString()
  const orders = [
    makeOrder(1, { createdAt: day(2), status: 'completed', totalCents: 2650, shippingCents: 500, taxCents: 150, discountCents: 100, customerId: 21,
      items: [{ name: 'Mug', productId: 400, quantity: 2, unitPriceCents: 1000 }], refunds: [{ id: 1, totalCents: 650 }] }),
    makeOrder(2, { createdAt: day(2, 18), status: 'processing', totalCents: 1000, shippingCents: 0,
      items: [{ name: 'Tee', productId: 300, quantity: 1, unitPriceCents: 1000 }, { name: 'Mug', productId: 400, quantity: 3, unitPriceCents: 0 }] }),
    makeOrder(3, { createdAt: day(4), status: 'pending', totalCents: 99999 }),
    makeOrder(4, { createdAt: day(9), status: 'completed', totalCents: 99999 }),
  ]
  const { adapter } = memoryAdapter(orders)
  const emulator = createWooEmulate({ store: { name: 'Example', url: origin }, auth, adapter })
  const [report] = await (await request(emulator, '/wc/v3/reports/sales', { query: 'date_min=2026-03-01&date_max=2026-03-05' })).json()
  assert.equal(report.total_orders, 2)
  assert.equal(report.total_items, 6)
  assert.equal(report.total_sales, '30.00') // 26.50 + 10.00 - 6.50 refunded
  assert.equal(report.total_shipping, '5.00')
  assert.equal(report.total_tax, '1.50')
  assert.equal(report.net_sales, '23.50')
  assert.equal(report.total_refunds, 6.5)
  assert.equal(report.total_discount, '1.00')
  assert.equal(report.totals_grouped_by, 'day')
  assert.deepEqual(Object.keys(report.totals), ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05'])
  assert.deepEqual(report.totals['2026-03-02'], { sales: '30.00', orders: 2, items: 6, tax: '1.50', shipping: '5.00', discount: '1.00', customers: 2 })
  assert.equal(report.total_customers, 2)

  const sellers = await (await request(emulator, '/wc/v3/reports/top_sellers', { query: 'date_min=2026-03-01&date_max=2026-03-05' })).json()
  assert.deepEqual(sellers.map(({ title, product_id, quantity }) => ({ title, product_id, quantity })), [
    { title: 'Mug', product_id: 400, quantity: 5 },
    { title: 'Tee', product_id: 300, quantity: 1 },
  ])
  assert.equal((await request(emulator, '/wc/v3/reports/sales', { query: 'period=decade' })).status, 400)
  const year = await (await request(emulator, '/wc/v3/reports/sales', { query: 'period=year' })).json()
  assert.equal(year[0].totals_grouped_by, 'month')
})

test('large report ranges fail clearly instead of truncating', async () => {
  const { adapter } = memoryAdapter([])
  adapter.listOrders = async (params) => ({
    orders: Array.from({ length: params.perPage }, (_, i) => makeOrder(params.offset + i + 1)),
    totalCount: 10_000,
  })
  const emulator = createWooEmulate({ store: { name: 'Example', url: origin }, auth, adapter })
  const response = await request(emulator, '/wc/v3/reports/sales', { query: 'period=year' })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).code, 'woocommerce_rest_report_too_large')
})

test('report index and totals reflect available data sources', async () => {
  const { adapter } = memoryAdapter([makeOrder(1)])
  adapter.products = memoryCatalog().catalog
  const plain = createWooEmulate({ store: { name: 'Example', url: origin }, auth, adapter: memoryAdapter([]).adapter })
  assert.deepEqual((await (await request(plain, '/wc/v3/reports')).json()).map((row) => row.slug), ['sales', 'top_sellers', 'orders/totals'])
  adapter.reports = { customersTotals: async () => ({ paying: 4, nonPaying: 9 }) }
  const emulator = createWooEmulate({ store: { name: 'Example', url: origin }, auth, adapter })
  assert.equal((await (await request(emulator, '/wc/v3/reports')).json()).length, 5)
  const customersTotals = await (await request(emulator, '/wc/v3/reports/customers/totals')).json()
  assert.deepEqual(customersTotals.map((row) => row.total), [4, 9])
  const productTotals = await (await request(emulator, '/wc/v3/reports/products/totals')).json()
  assert.deepEqual(productTotals.map((row) => row.slug), ['external', 'grouped', 'simple', 'variable'])
})

function keyStore(keys) {
  const deleted = []
  const created = []
  return {
    deleted, created, keys,
    async findApiKey(consumerKey) { return keys.find((key) => key.consumerKey === consumerKey) || null },
    async createApiKey(key) { const keyId = 100 + created.length; created.push({ keyId, ...key }); keys.push({ keyId, ...key }); return { keyId } },
    async deleteApiKey(keyId) { deleted.push(keyId) },
  }
}

const basicFor = (key, secret) => ({ Authorization: 'Basic ' + btoa(`${key}:${secret}`) })

test('API keys enforce read, write, and read_write permissions per method', async () => {
  const store = keyStore([
    { keyId: 2, consumerKey: 'ck_read', consumerSecret: 'cs_read', permissions: 'read' },
    { keyId: 3, consumerKey: 'ck_write', consumerSecret: 'cs_write', permissions: 'write' },
    { keyId: 4, consumerKey: 'ck_rw', consumerSecret: 'cs_rw', permissions: 'read_write' },
  ])
  const { emulator } = setup({ apiKeys: store })
  const read = basicFor('ck_read', 'cs_read')
  assert.equal((await request(emulator, '/wc/v3/orders', { headers: read })).status, 200)
  const denied = await request(emulator, '/wc/v3/orders/1001', { method: 'PUT', body: { status: 'completed' }, headers: read })
  assert.equal(denied.status, 401)
  assert.deepEqual(await denied.json(), {
    code: 'woocommerce_rest_authentication_error', message: 'The API key provided does not have write permissions.', data: { status: 401 },
  })
  const writeOnly = basicFor('ck_write', 'cs_write')
  assert.equal((await request(emulator, '/wc/v3/orders', { headers: writeOnly })).status, 401)
  assert.equal((await request(emulator, '/wc/v3/orders/1001', { method: 'PUT', body: { status: 'completed' }, headers: writeOnly })).status, 200)
  assert.equal((await request(emulator, '/wc/v3/orders/1001', { method: 'PUT', body: {}, headers: basicFor('ck_rw', 'cs_rw') })).status, 200)
  assert.equal((await request(emulator, '/wc/v3/orders', { headers: basicFor('ck_rw', 'wrong') })).status, 401)
  // Unknown keys fall through to the static auth key.
  assert.equal((await request(emulator, '/wc/v3/orders')).status, 200)
})

test('static keys can be read-only, and credentials are required at startup', async () => {
  const { adapter } = memoryAdapter([makeOrder(1)])
  const emulator = createWooEmulate({ store: { name: 'Example', url: origin }, auth: { ...auth, permissions: 'read' }, adapter })
  assert.equal((await request(emulator, '/wc/v3/orders')).status, 200)
  assert.equal((await request(emulator, '/wc/v3/orders/1001', { method: 'PUT', body: {} })).status, 401)
  assert.throws(() => createWooEmulate({ store: { name: 'x', url: origin }, adapter }), /requires API credentials/)
  const keysOnly = createWooEmulate({ store: { name: 'x', url: origin }, adapter, apiKeys: keyStore([]) })
  assert.equal((await request(keysOnly, '/wc/v3/orders')).status, 401)
})

const oauthConfig = {
  allowedCallbackUrls: ['https://service.example/callback'],
  allowedReturnUrls: ['https://service.example/done'],
  authorize: async () => true,
}

function approve(emulator, scope) {
  const url = new URL('/wc-auth/v1/authorize', origin)
  url.search = new URLSearchParams({
    app_name: 'Inventory App', scope, user_id: '7', callback_url: oauthConfig.allowedCallbackUrls[0], return_url: oauthConfig.allowedReturnUrls[0],
  }).toString()
  return emulator.handleRequest(new Request(url, { method: 'POST', headers: { Origin: origin } }))
}

test('one-click authorization mints a separate key per app with the requested scope', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }))
  const store = keyStore([])
  const { emulator } = setup({ apiKeys: store, oauth: oauthConfig })
  const response = await approve(emulator, 'read')
  assert.equal(response.status, 302)
  const body = JSON.parse(fetch.mock.calls[0].arguments[1].body)
  assert.equal(body.key_id, 100)
  assert.equal(body.key_permissions, 'read')
  assert.equal(body.user_id, '7')
  assert.match(body.consumer_key, /^ck_[0-9a-f]{40}$/)
  assert.match(body.consumer_secret, /^cs_[0-9a-f]{40}$/)
  assert.notEqual(body.consumer_key, auth.consumerKey)
  assert.equal(store.created[0].appName, 'Inventory App')
  assert.match(store.created[0].description, /^Inventory App - API \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\)$/)

  const minted = basicFor(body.consumer_key, body.consumer_secret)
  assert.equal((await request(emulator, '/wc/v3/orders', { headers: minted })).status, 200)
  assert.equal((await request(emulator, '/wc/v3/orders/1001', { method: 'PUT', body: {}, headers: minted })).status, 401)

  await approve(emulator, 'write')
  assert.equal(JSON.parse(fetch.mock.calls[1].arguments[1].body).key_permissions, 'write')
  assert.equal(store.created.length, 2)
  assert.equal((await approve(emulator, 'admin')).status, 400)
})

test('minted keys are deleted when the callback rejects them', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 500 }))
  const store = keyStore([])
  const { emulator } = setup({ apiKeys: store, oauth: oauthConfig })
  assert.equal((await approve(emulator, 'read_write')).status, 502)
  assert.deepEqual(store.deleted, [100])
})

test('a shared static key is offered only for a scope matching its permissions', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }))
  const { emulator } = setup({ auth: { ...auth, permissions: 'read', keyId: 9 }, oauth: oauthConfig })
  assert.equal((await approve(emulator, 'read_write')).status, 400)
  assert.equal((await approve(emulator, 'read')).status, 302)
  const body = JSON.parse(fetch.mock.calls[0].arguments[1].body)
  assert.equal(body.key_id, 9)
  assert.equal(body.consumer_key, auth.consumerKey)
})

// Standard OAuth 1.0a signing, written independently of the library.
function oauthSign(method, url, extra, secret, algorithm = 'sha256') {
  const enc = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  const target = new URL(url)
  const params = { ...Object.fromEntries(target.searchParams), ...extra }
  const paramString = Object.keys(params).sort().map((key) => `${enc(key)}=${enc(params[key])}`).join('&')
  const base = [method, enc(target.origin + target.pathname), enc(paramString)].join('&')
  return createHmac(algorithm, `${secret}&`).update(base).digest('base64')
}

function oauthRequest(emulator, { method = 'GET', path = '/wp-json/wc/v3/orders?per_page=5', nonce = 'n' + Math.random(), timestamp = Math.floor(Date.now() / 1000), algorithm = 'sha256', secret = auth.consumerSecret, header = false, tamper = false } = {}) {
  const base = `http://store.example${path}`
  const oauth = {
    oauth_consumer_key: auth.consumerKey, oauth_nonce: nonce, oauth_timestamp: String(timestamp),
    oauth_signature_method: algorithm === 'sha1' ? 'HMAC-SHA1' : 'HMAC-SHA256',
  }
  const signature = oauthSign(method, base, oauth, secret, algorithm)
  const signed = { ...oauth, oauth_signature: tamper ? signature.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) : signature }
  if (header) {
    const value = 'OAuth ' + Object.entries(signed).map(([k, v]) => `${k}="${encodeURIComponent(v)}"`).join(', ')
    return emulator.handleRequest(new Request(base, { method, headers: { Authorization: value } }))
  }
  const url = new URL(base)
  for (const [key, value] of Object.entries(signed)) url.searchParams.set(key, value)
  return emulator.handleRequest(new Request(url, { method }))
}

test('OAuth 1.0a one-legged signatures authenticate plain-HTTP clients', async () => {
  const nonces = new Set()
  const { emulator } = setup({
    oauth1: { useNonce: async (key, nonce) => { const id = `${key}:${nonce}`; if (nonces.has(id)) return false; nonces.add(id); return true } },
  })
  assert.equal((await oauthRequest(emulator)).status, 200)
  assert.equal((await oauthRequest(emulator, { algorithm: 'sha1' })).status, 200)
  assert.equal((await oauthRequest(emulator, { header: true })).status, 200)
  assert.equal((await oauthRequest(emulator, { path: '/wp-json/wc/v3/orders?search=a%20b&status=processing' })).status, 200)

  const bad = await oauthRequest(emulator, { tamper: true })
  assert.equal(bad.status, 401)
  assert.equal((await bad.json()).message, 'Invalid signature - provided signature does not match.')
  const stale = await oauthRequest(emulator, { timestamp: Math.floor(Date.now() / 1000) - 3600 })
  assert.equal((await stale.json()).message, 'Invalid timestamp.')
  await oauthRequest(emulator, { nonce: 'reused' })
  const replay = await oauthRequest(emulator, { nonce: 'reused' })
  assert.equal((await replay.json()).message, 'Invalid nonce - nonce has already been used.')
  const wrongSecret = await oauthRequest(emulator, { secret: 'cs_other' })
  assert.equal(wrongSecret.status, 401)
})

test('OAuth 1.0a is off unless a nonce store is configured', async () => {
  const { emulator } = setup()
  const response = await oauthRequest(emulator)
  assert.equal(response.status, 401)
  assert.equal((await response.json()).code, 'woocommerce_rest_cannot_view')
})

test('customer and coupon webhooks carry serialized resources', async () => {
  const outbound = recordingFetch()
  const { emulator } = setup({ webhooks: { store: memoryWebhookStore(), fetch: outbound.fetch } })
  await request(emulator, '/wc/v3/webhooks', { method: 'POST', body: { topic: 'customer.created', delivery_url: 'https://hooks.example.net/c' } })
  await request(emulator, '/wc/v3/webhooks', { method: 'POST', body: { topic: 'coupon.updated', delivery_url: 'https://hooks.example.net/k' } })
  await emulator.webhooks.dispatch('customer.created', customers[0])
  await emulator.webhooks.dispatch('coupon.updated', coupons[0])
  const bodies = outbound.calls.filter((call) => call.headers.get('x-wc-webhook-id')).map((call) => JSON.parse(call.body))
  assert.equal(bodies[0].email, 'bea@example.com')
  assert.equal(bodies[1].code, 'save15')
})
