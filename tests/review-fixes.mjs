// Regressions for issues found in an independent review of phases 0-4.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWooEmulate, isSafeDeliveryUrl } from '../dist/index.js'
import { auth, makeOrder, memoryAdapter, memoryCatalog, origin, request } from './helpers.mjs'

function setup(orders = [makeOrder(1), makeOrder(2)], extra = {}) {
  const { adapter, calls } = memoryAdapter(orders)
  return { emulator: createWooEmulate({ store: { name: 'Example', url: origin }, auth, adapter, ...extra }), adapter, calls, orders }
}

test('delivery URL policy blocks trailing-dot and IPv6-embedded internal targets', () => {
  for (const url of [
    'https://localhost./x', 'https://x.internal./x', 'https://printer.local./x', 'https://svc.ns.svc.cluster.local/x',
    'https://[64:ff9b::a00:5]/x', 'https://[::7f00:1]/x', 'https://[2002:7f00:1::]/x', 'https://[fec0::1]/x',
    'https://[ff02::1]/x', 'https://[::ffff:10.0.0.1]/x', 'https://[2001:0:4136:e378::1]/x', 'https://[64:ff9b:1::1]/x',
  ]) {
    assert.equal(isSafeDeliveryUrl(new URL(url)), false, url)
  }
  for (const url of ['https://hooks.example.net./x', 'https://[2606:4700::1111]/x', 'https://[64:ff9b::808:808]/x', 'https://[2002:808:808::1]/x']) {
    assert.equal(isSafeDeliveryUrl(new URL(url)), true, url)
  }
})

test('the consent page keeps the Origin header on the approval POST', async () => {
  const { emulator } = setup(undefined, {
    oauth: { allowedCallbackUrls: ['https://service.example/cb'], allowedReturnUrls: ['https://service.example/done'], authorize: async () => true },
  })
  const url = new URL('/wc-auth/v1/authorize', origin)
  url.search = new URLSearchParams({ app_name: 'App', scope: 'read_write', user_id: '1', callback_url: 'https://service.example/cb', return_url: 'https://service.example/done' }).toString()
  const consent = await emulator.handleRequest(new Request(url))
  // `no-referrer` makes browsers send `Origin: null` on the form POST, which fails approval.
  assert.equal(consent.headers.get('referrer-policy'), 'same-origin')
})

test('order updates never return a different order than the one addressed', async () => {
  const orders = [makeOrder(1, { id: 'ord_1' }), makeOrder(2, { id: 'ord_2', orderNumber: 'ord_1', customer: { email: 'victim@example.com' } })]
  const { emulator } = setup(orders)
  const updated = await (await request(emulator, '/wc/v3/orders/1001', { method: 'PUT', body: { status: 'completed' } })).json()
  assert.equal(updated.id, 1001)
  assert.notEqual(updated.billing.email, 'victim@example.com')
})

test('indexed array parameters from PHP-style clients are honored; empty lists are ignored', async () => {
  const { emulator, calls } = setup()
  await request(emulator, '/wc/v3/orders', { query: 'include[0]=1001&include[1]=1002&status[0]=completed&exclude[3]=1009' })
  assert.deepEqual(calls.at(-1).include, [1001, 1002])
  assert.deepEqual(calls.at(-1).exclude, [1009])
  assert.equal(calls.at(-1).status, 'completed')
  await request(emulator, '/wc/v3/orders', { query: 'include=&status=' })
  assert.equal(calls.at(-1).include, undefined)
  assert.equal(calls.at(-1).status, undefined)
})

test('offset requests link to the next offset instead of looping on page', async () => {
  const { emulator } = setup(Array.from({ length: 23 }, (_, i) => makeOrder(i + 1)))
  const seen = []
  let url = `${origin}/wp-json/wc/v3/orders?offset=10&per_page=5&orderby=id&order=asc`
  for (let guard = 0; url && guard < 10; guard++) {
    const response = await request(emulator, url.slice(`${origin}/wp-json`.length))
    seen.push(...(await response.json()).map((order) => order.id))
    const next = response.headers.get('link').split(',').find((part) => part.includes('rel="next"'))
    url = next ? next.split(';')[0].trim().slice(1, -1) : null
  }
  assert.equal(seen.length, 13)
  assert.equal(new Set(seen).size, 13)
  const first = await request(emulator, '/wc/v3/orders', { query: 'offset=10&per_page=5' })
  assert.match(first.headers.get('link'), /offset=5[^>]*>; rel="prev"/)
})

test('refund line items are merged by ID and may reference shipping and fee lines', async () => {
  const order = makeOrder(1, {
    totalCents: 3000,
    items: [{ id: 11, name: 'Mug', quantity: 1, unitPriceCents: 2000 }],
    shippingLines: [{ id: 21, methodTitle: 'Ground', methodId: 'flat_rate', totalCents: 500 }],
    feeLines: [{ id: 31, name: 'Handling', totalCents: 500 }],
  })
  const created = []
  const { adapter } = memoryAdapter([order])
  adapter.listOrderRefunds = async () => []
  adapter.createOrderRefund = async (id, input) => { created.push(input); return { id: 1, amountCents: input.amountCents, createdAt: new Date() } }
  const api = createWooEmulate({ store: { name: 'Example', url: origin }, auth, adapter })
  const duplicate = await request(api, '/wc/v3/orders/1001/refunds', {
    method: 'POST', body: { line_items: [11, 11, 11].map((id) => ({ id, quantity: 1, refund_total: '1.00' })) },
  })
  assert.equal(duplicate.status, 400)
  const mixed = await request(api, '/wc/v3/orders/1001/refunds', {
    method: 'POST', body: { line_items: [{ id: 11, quantity: 1, refund_total: '20.00' }, { id: 21, refund_total: '5.00' }, { id: 31, refund_total: '5.00' }] },
  })
  assert.equal(mixed.status, 201)
  assert.equal(created[0].amountCents, 3000)
  assert.deepEqual(created[0].lineItems.map((item) => item.lineItemId), [11, 21, 31])
})

test('refunds fail closed when the order total is unknown', async () => {
  const { adapter } = memoryAdapter([makeOrder(1, { totalCents: undefined })])
  adapter.createOrderRefund = async () => { throw new Error('must not be called') }
  const api = createWooEmulate({ store: { name: 'Example', url: origin }, auth, adapter })
  const response = await request(api, '/wc/v3/orders/1001/refunds', { method: 'POST', body: { amount: '1.00' } })
  assert.equal(response.status, 400)
})

test('product updates honor v1/v2 in_stock, reject other changed fields, and ignore key order', async () => {
  const { adapter } = memoryAdapter([makeOrder(1)])
  const memory = memoryCatalog()
  adapter.products = memory.catalog
  const api = createWooEmulate({ store: { name: 'Example', url: origin }, auth, adapter })
  const v2 = await request(api, '/wc/v2/products/300', { method: 'PUT', body: { in_stock: false } })
  assert.equal(v2.status, 200)
  assert.deepEqual(memory.calls.updates.at(-1).changes, { stockStatus: 'outofstock' })
  for (const body of [{ low_stock_amount: 3 }, { parent_id: 9 }, { grouped_products: [1] }]) {
    assert.equal((await request(api, '/wc/v3/products/400', { method: 'PUT', body })).status, 400, JSON.stringify(body))
  }
  const sortKeys = (value) => Array.isArray(value) ? value.map(sortKeys)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().reverse().map((key) => [key, sortKeys(value[key])])) : value
  const current = await (await request(api, '/wc/v3/products/300')).json()
  const echoed = await request(api, '/wc/v3/products/300', { method: 'PUT', body: { ...sortKeys(current), stock_quantity: 5, manage_stock: true } })
  assert.equal(echoed.status, 200)
})

test('report ranges reject impossible dates and oversized spans', async () => {
  const { emulator } = setup()
  for (const query of ['date_min=2026-13-45', 'date_min=1970-01-01&date_max=9999-12-31', 'date_max=9999-12-31', 'date_min=1969-12-31&date_max=1970-01-02']) {
    const response = await request(emulator, '/wc/v3/reports/sales', { query })
    assert.equal(response.status, 400, query)
    assert.equal((await response.json()).code, 'rest_invalid_param')
  }
})

test('sales report total_tax includes shipping tax', async () => {
  const day = new Date(Date.UTC(2026, 2, 2, 12)).toISOString()
  const { emulator } = setup([makeOrder(1, { createdAt: day, totalCents: 2000, taxCents: 110, shippingTaxCents: 10 })])
  const [report] = await (await request(emulator, '/wc/v3/reports/sales', { query: 'date_min=2026-03-01&date_max=2026-03-03' })).json()
  assert.equal(report.total_tax, '1.10')
  assert.equal(report.totals['2026-03-02'].tax, '1.10')
})

test('OAuth headers ignore realm, as WooCommerce does', async () => {
  const { createHmac } = await import('node:crypto')
  const nonces = new Set()
  const { emulator } = setup(undefined, { oauth1: { useNonce: async (k, n) => (nonces.has(n) ? false : (nonces.add(n), true)) } })
  const enc = (v) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  const url = 'http://store.example/wp-json/wc/v3/orders'
  const oauth = { oauth_consumer_key: auth.consumerKey, oauth_nonce: 'abc', oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_signature_method: 'HMAC-SHA1' }
  const base = ['GET', enc(url), enc(Object.keys(oauth).sort().map((k) => `${enc(k)}=${enc(oauth[k])}`).join('&'))].join('&')
  const signature = createHmac('sha1', `${auth.consumerSecret}&`).update(base).digest('base64')
  const header = `OAuth realm="Example", ${Object.entries({ ...oauth, oauth_signature: signature }).map(([k, v]) => `${k}="${enc(v)}"`).join(', ')}`
  assert.equal((await emulator.handleRequest(new Request(url, { headers: { Authorization: header } }))).status, 200)
})

test('failures in key stores and auth resolvers produce JSON errors, not rejections', async () => {
  const { adapter } = memoryAdapter([makeOrder(1)])
  const throwing = createWooEmulate({ store: { name: 'x', url: origin }, adapter, apiKeys: { findApiKey: async () => { throw new Error('db down') } } })
  const response = await request(throwing, '/wc/v3/orders')
  assert.equal(response.status, 500)
  assert.equal((await response.json()).code, 'woocommerce_rest_authentication_error')
  const undefinedAuth = createWooEmulate({ store: { name: 'x', url: origin }, adapter, auth: async () => undefined })
  assert.equal((await request(undefinedAuth, '/wc/v3/orders')).status, 401)
})

test('orders without a valid API ID read as not found instead of a 500', async () => {
  const { adapter } = memoryAdapter([makeOrder(1)])
  adapter.getOrderByWooCommerceId = async () => ({ ...makeOrder(1), id: 'ord_x', wooCommerceId: undefined })
  const api = createWooEmulate({ store: { name: 'x', url: origin }, auth, adapter })
  const response = await request(api, '/wc/v3/orders/1001')
  assert.equal(response.status, 404)
  assert.doesNotMatch(await response.text(), /31-bit/)
})

test('integer parameters must be safe integers', async () => {
  const { emulator } = setup()
  for (const query of ['page=99999999999999999999', 'customer=123456789012345678901']) {
    assert.equal((await request(emulator, '/wc/v3/orders', { query })).status, 400, query)
  }
})

test('wall-clock times in a DST gap move forward, as in PHP', async () => {
  const { adapter, calls } = memoryAdapter([makeOrder(1)])
  const api = createWooEmulate({ store: { name: 'x', url: origin, timezone: 'America/New_York' }, auth, adapter })
  await request(api, '/wc/v3/orders', { query: 'after=2026-03-08T02:30:00&before=2026-11-01T01:30:00' })
  assert.equal(calls.at(-1).after, '2026-03-08T07:30:00.000Z')
  assert.equal(calls.at(-1).before, '2026-11-01T05:30:00.000Z')
})

// Regressions for Codex review findings on the pull request.

test('refund quantities account for units already refunded', async () => {
  const order = makeOrder(1, { totalCents: 4000, items: [{ id: 11, name: 'Mug', quantity: 2, unitPriceCents: 2000 }] })
  const { adapter } = memoryAdapter([order])
  const created = []
  adapter.listOrderRefunds = async () => [
    { id: 70, amountCents: 2000, createdAt: '2026-01-02T00:00:00Z', lineItems: [{ refundedItemId: 11, name: 'Mug', quantity: 1, totalCents: 2000 }] },
  ]
  adapter.createOrderRefund = async (id, input) => { created.push(input); return { id: 71, amountCents: input.amountCents, createdAt: new Date() } }
  const api = createWooEmulate({ store: { name: 'Example', url: origin }, auth, adapter })
  const again = await request(api, '/wc/v3/orders/1001/refunds', {
    method: 'POST', body: { line_items: [{ id: 11, quantity: 2, refund_total: '20.00' }] },
  })
  assert.equal(again.status, 400)
  assert.match(JSON.stringify(await again.json()), /remaining refundable quantity/)
  const remaining = await request(api, '/wc/v3/orders/1001/refunds', {
    method: 'POST', body: { line_items: [{ id: 11, quantity: 1, refund_total: '20.00' }] },
  })
  assert.equal(remaining.status, 201)
  assert.equal(created.length, 1)
})

test('OAuth signatures cover repeated query parameters', async () => {
  const { createHmac } = await import('node:crypto')
  const nonces = new Set()
  const { emulator, calls } = setup(undefined, { oauth1: { useNonce: async (k, n) => (nonces.has(n) ? false : (nonces.add(n), true)) } })
  const enc = (v) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  const target = new URL('http://store.example/wp-json/wc/v3/orders?status[]=processing&status[]=completed')
  const oauth = { oauth_consumer_key: auth.consumerKey, oauth_nonce: 'dup', oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_signature_method: 'HMAC-SHA256' }
  const pairs = [...target.searchParams, ...Object.entries(oauth)].map(([k, v]) => [enc(k), enc(v)]).sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : 1))
  const base = ['GET', enc(target.origin + target.pathname), enc(pairs.map(([k, v]) => `${k}=${v}`).join('&'))].join('&')
  const signature = createHmac('sha256', `${auth.consumerSecret}&`).update(base).digest('base64')
  for (const [key, value] of Object.entries({ ...oauth, oauth_signature: signature })) target.searchParams.set(key, value)
  const response = await emulator.handleRequest(new Request(target))
  assert.equal(response.status, 200)
  assert.deepEqual(calls.at(-1).status, ['processing', 'completed'])
})

test('impossible calendar dates in filters are rejected instead of rolling over', async () => {
  const { emulator } = setup()
  for (const value of ['2026-02-31T00:00:00', '2026-02-31T00:00:00Z', '2026-02-31T00:00:00%2B02:00', '2026-02-03T24:00:00', '2026-13-01T00:00:00', '2026-02-03T10:61:00']) {
    const response = await request(emulator, '/wc/v3/orders', { query: `after=${value}` })
    assert.equal(response.status, 400, value)
    assert.equal((await response.json()).code, 'rest_invalid_param')
  }
  const zoned = createWooEmulate({ store: { name: 'x', url: origin, timezone: 'America/Chicago' }, auth, adapter: memoryAdapter([]).adapter })
  assert.equal((await request(zoned, '/wc/v3/orders', { query: 'after=2026-02-29T00:00:00' })).status, 400)
  assert.equal((await request(zoned, '/wc/v3/orders', { query: 'after=2028-02-29T00:00:00' })).status, 200)
})
