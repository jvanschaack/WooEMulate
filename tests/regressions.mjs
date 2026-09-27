import test from 'node:test'
import assert from 'node:assert/strict'
import { createWooEmulate, getWcNumericId } from '../dist/index.js'

const origin = 'https://store.example'
const callbackUrl = 'https://service.example/callback'
const returnUrl = 'https://service.example/done'
const auth = { consumerKey: 'ck_fixture', consumerSecret: 'cs_fixture' }
const headers = { Authorization: 'Basic ' + btoa(auth.consumerKey + ':' + auth.consumerSecret) }

function order(id, wooCommerceId, orderNumber = 'STORE-9852') {
  return {
    id, wooCommerceId, orderNumber, status: 'processing',
    createdAt: '2026-09-27T12:00:00Z', totalCents: 1000,
    shippingAddress: { firstName: 'Example', address1: '1 Example St', city: 'Austin', state: 'TX', postalCode: '78701' },
    items: [{ name: 'Example item', quantity: 1, unitPriceCents: 1000 }],
  }
}

function fixture(orders = [order('ord_retail', 4101)]) {
  const writes = []
  const config = {
    store: { name: 'Example store', url: origin },
    auth,
    adapter: {
      async listOrders() { return { orders, totalCount: orders.length } },
      async getOrder(id) { return orders.find((row) => row.id === id) || null },
      async getOrderByWooCommerceId(id) { return orders.find((row) => (row.wooCommerceId ?? Number(row.id)) === id) || null },
      async updateOrderStatus(id, status) {
        writes.push({ id, status })
        orders.find((row) => row.id === id).status = status
      },
      async onShipmentTrackingCreated(id, tracking) {
        writes.push({ id, tracking })
        orders.find((row) => row.id === id).tracking = { id: 7, ...tracking }
        return { id: 7 }
      },
    },
  }
  return { config, writes }
}

function api(emulator, path, method = 'GET', body) {
  return emulator.handleRequest(new Request(origin + '/wp-json/wc/v3' + path, {
    method, headers: { ...headers, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
}

function connectionRequest(method = 'GET', changes = {}, requestHeaders = {}) {
  const url = new URL('/wc-auth/v1/authorize', origin)
  url.search = new URLSearchParams({
    app_name: 'Example app', user_id: '42', scope: 'read_write',
    callback_url: callbackUrl, return_url: returnUrl, ...changes,
  }).toString()
  return new Request(url, { method, headers: requestHeaders })
}

function enableOAuth(config, authorize = async () => true) {
  config.oauth = { allowedCallbackUrls: [callbackUrl], allowedReturnUrls: [returnUrl], authorize }
}

test('numeric IDs reject lossy conversions, invalid ranges, and leading zeros', () => {
  for (const value of [1, '1', 9852, '9852', 2147483647]) assert.equal(getWcNumericId(value), Number(value))
  for (const value of ['STORE-9852', 'WHOLESALE-9852', '001', '', ' 1 ', 0, -1, 1.5, Infinity, 2147483648]) {
    assert.throws(() => getWcNumericId(value), /Persist a unique wooCommerceId/)
  }
})

test('persisted API IDs survive instance recreation and route writes to original IDs', async () => {
  const rows = [order('ord_retail', 4101, 'STORE-9852'), order('ord_wholesale', 4102, 'WHOLESALE-9852')]
  const { config, writes } = fixture(rows)
  const listed = await (await api(createWooEmulate(config), '/orders')).json()
  assert.deepEqual(listed.map((row) => row.id), [4101, 4102])
  const emulator = createWooEmulate(config)
  for (const row of listed) {
    const fetched = await api(emulator, '/orders/' + row.id)
    assert.equal(fetched.status, 200)
    assert.equal((await fetched.json()).number, row.number)
  }
  const updated = await api(emulator, '/orders/4102', 'PUT', { status: 'pending' })
  assert.equal(updated.status, 200)
  assert.equal((await updated.json()).status, 'pending')
  assert.deepEqual(writes[0], { id: 'ord_wholesale', status: 'pending' })
  const tracking = await api(emulator, '/orders/4101/shipment-trackings', 'POST', {
    tracking_number: '1Z999AA10123456784', tracking_provider: 'UPS',
  })
  assert.equal(tracking.status, 201)
  assert.equal(writes[1].id, 'ord_retail')
  const saved = await (await api(emulator, '/orders/4101/shipment-trackings')).json()
  assert.equal(saved[0].tracking_number, '1Z999AA10123456784')
  rows[0].orderNumber = 'RENAMED-22'
  assert.equal((await (await api(emulator, '/orders/4101')).json()).id, 4101)
})

test('numeric original IDs work without an explicit mapping hook', async () => {
  for (const id of [123, '123']) {
    const { config } = fixture([order(id, undefined)])
    delete config.adapter.getOrderByWooCommerceId
    const response = await api(createWooEmulate(config), '/orders/123')
    assert.equal(response.status, 200)
    assert.equal((await response.json()).id, 123)
  }
})

test('string IDs without a persisted API ID fail rather than silently colliding', async () => {
  const { config } = fixture([order('ord_retail', undefined)])
  const response = await api(createWooEmulate(config), '/orders')
  assert.equal(response.status, 500)
  assert.match((await response.json()).message, /wooCommerceId/)
})

test('unknown, invalid, and mismatched API IDs cannot mutate another order', async () => {
  const { config, writes } = fixture()
  config.adapter.getOrderByWooCommerceId = async () => order('wrong_order', 9999)
  const emulator = createWooEmulate(config)
  for (const id of ['4101', '0004101', 'STORE-4101']) {
    const response = await api(emulator, '/orders/' + id, 'PUT', { status: 'completed' })
    assert.equal(response.status, 404)
  }
  assert.deepEqual(writes, [])
})

test('one-click authorization is disabled by default for GET and POST', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response())
  const { config } = fixture()
  for (const method of ['GET', 'POST']) {
    const response = await createWooEmulate(config).handleRequest(connectionRequest(method))
    assert.equal(response.status, 403)
  }
  assert.equal(fetch.mock.callCount(), 0)
})

test('authorized GET displays consent without resolving or dispatching credentials', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response())
  const { config } = fixture()
  config.auth = async () => { throw new Error('Must not resolve keys on GET') }
  enableOAuth(config)
  const response = await createWooEmulate(config).handleRequest(connectionRequest())
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
  assert.match(await response.text(), /Approve Connection/)
  assert.equal(fetch.mock.callCount(), 0)
})

test('owner authorization fails closed on false, thrown errors, and truthy non-booleans', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response())
  for (const authorize of [async () => false, async () => { throw new Error('session unavailable') }, async () => 'yes']) {
    const { config } = fixture()
    enableOAuth(config, authorize)
    for (const method of ['GET', 'POST']) {
      const response = await createWooEmulate(config).handleRequest(connectionRequest(method, {}, { Origin: origin }))
      assert.equal(response.status, 403)
    }
  }
  assert.equal(fetch.mock.callCount(), 0)
})

test('approval rejects missing or foreign Origin and requests on another store origin', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response())
  const { config } = fixture()
  enableOAuth(config)
  const emulator = createWooEmulate(config)
  for (const requestHeaders of [{}, { Origin: 'https://other.example' }, { Origin: 'null' }]) {
    assert.equal((await emulator.handleRequest(connectionRequest('POST', {}, requestHeaders))).status, 403)
  }
  const url = connectionRequest().url.replace(origin, 'http://store.example')
  assert.equal((await emulator.handleRequest(new Request(url))).status, 403)
  assert.equal(fetch.mock.callCount(), 0)
})

test('callback and return URLs require exact configured HTTPS matches', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response())
  const { config } = fixture()
  enableOAuth(config)
  const emulator = createWooEmulate(config)
  for (const changes of [
    { callback_url: 'https://other.example/callback' },
    { callback_url: callbackUrl + '?redirect=https://other.example' },
    { callback_url: 'http://service.example/callback' },
    { callback_url: 'https://user:password@service.example/callback' },
    { callback_url: callbackUrl + '#fragment' },
    { return_url: 'https://other.example/done' },
    { return_url: 'javascript:alert(1)' },
    { scope: 'read' },
  ]) {
    const response = await emulator.handleRequest(connectionRequest('POST', changes, { Origin: origin }))
    assert.equal(response.status, 400)
  }
  assert.equal(fetch.mock.callCount(), 0)
})

test('approved POST dispatches keys once to the allowed callback and reports success', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 201 }))
  const { config } = fixture()
  let authorized = 0
  config.adapter.onOAuthAuthorized = async (payload) => { assert.equal(payload.userId, '42'); authorized++ }
  enableOAuth(config)
  const response = await createWooEmulate(config).handleRequest(connectionRequest('POST', {}, { Origin: origin }))
  assert.equal(response.status, 302)
  assert.equal(new URL(response.headers.get('location')).searchParams.get('success'), '1')
  assert.equal(fetch.mock.callCount(), 1)
  const [target, init] = fetch.mock.calls[0].arguments
  assert.equal(target, callbackUrl)
  assert.equal(init.redirect, 'manual')
  assert.equal(JSON.parse(init.body).consumer_secret, auth.consumerSecret)
  assert.equal(authorized, 1)
})

test('failed or redirected callbacks never report success or follow redirects', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 500 }))
  const { config } = fixture()
  let authorized = false
  config.adapter.onOAuthAuthorized = async () => { authorized = true }
  enableOAuth(config)
  for (const status of [400, 500, 302, 307]) {
    fetch.mock.mockImplementation(async () => new Response(null, { status }))
    const response = await createWooEmulate(config).handleRequest(connectionRequest('POST', {}, { Origin: origin }))
    assert.equal(response.status, 502)
    assert.equal(response.headers.get('location'), null)
    assert.equal(fetch.mock.calls.at(-1).arguments[1].redirect, 'manual')
  }
  fetch.mock.mockImplementation(async () => { throw new Error('network failure with sensitive detail') })
  const response = await createWooEmulate(config).handleRequest(connectionRequest('POST', {}, { Origin: origin }))
  assert.equal(response.status, 502)
  assert.doesNotMatch(await response.text(), /sensitive detail/)
  assert.equal(authorized, false)
})

test('unavailable credentials never reach the callback', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response())
  for (const credentialResult of [{ authenticated: false }, { authenticated: true }, { consumerKey: '', consumerSecret: '' }]) {
    const { config } = fixture()
    config.auth = async () => credentialResult
    enableOAuth(config)
    const response = await createWooEmulate(config).handleRequest(connectionRequest('POST', {}, { Origin: origin }))
    assert.equal(response.status, 403)
  }
  assert.equal(fetch.mock.callCount(), 0)
})

test('discovery advertises only supported order methods and namespaces', async () => {
  const { config } = fixture()
  const emulator = createWooEmulate(config)
  const discovery = await (await emulator.handleRequest(new Request(origin + '/wp-json'))).json()
  assert.ok(!discovery.namespaces.includes('wp/v2'))
  assert.deepEqual(discovery.routes['/wc/v3/orders'].methods, ['GET'])
  assert.ok(!discovery.routes['/wc/v3/orders/(?P<id>[\\d]+)'].methods.includes('DELETE'))
  assert.equal((await api(emulator, '/orders', 'POST', {})).status, 405)
})
