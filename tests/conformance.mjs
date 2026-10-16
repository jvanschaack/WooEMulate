import test from 'node:test'
import assert from 'node:assert/strict'
import { createWooEmulate } from '../dist/index.js'
import { auth, basic, makeOrder, memoryAdapter, origin, request } from './helpers.mjs'

function setup(count = 3, extra = {}) {
  const orders = Array.from({ length: count }, (_, i) => makeOrder(i + 1))
  const { adapter, calls } = memoryAdapter(orders)
  const emulator = createWooEmulate({ store: { name: 'Example', url: origin }, auth, adapter, ...extra })
  return { emulator, orders, calls, adapter }
}

/** Mirrors n8n's woocommerceApiRequestAllItems: per_page=100, follow rel="next" until absent. */
async function fetchAllLikeN8n(emulator) {
  const items = []
  let uri = `${origin}/wp-json/wc/v3/orders?per_page=100`
  let response
  do {
    response = await emulator.handleRequest(new Request(uri, { headers: { Authorization: basic } }))
    items.push(...(await response.json()))
    const link = response.headers.get('link')
    const links = link.split(',')
    const nextLink = links.find((entry) => entry.indexOf('rel="next"') !== -1)
    if (nextLink) uri = new URL(nextLink.split(';')[0].replace(/<(.*)>/, '$1')).href
  } while (response.headers.get('link')?.includes('rel="next"'))
  return items
}

test('every REST response advertises the API root in Link', async () => {
  const { emulator } = setup()
  for (const path of ['', '/wc/v3', '/wc/v3/orders', '/wc/v3/nope']) {
    const response = await request(emulator, path)
    assert.match(response.headers.get('link'), /^<https:\/\/store\.example\/wp-json\/>; rel="https:\/\/api\.w\.org\/"/)
  }
})

test('collections send prev/next Link headers without credentials', async () => {
  const { emulator } = setup(25)
  const response = await request(emulator, '/wc/v3/orders', {
    query: `page=2&per_page=10&status=processing&consumer_key=${auth.consumerKey}&consumer_secret=${auth.consumerSecret}`,
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-wp-total'), '25')
  assert.equal(response.headers.get('x-wp-totalpages'), '3')
  const link = response.headers.get('link')
  assert.match(link, /page=1[^>]*>; rel="prev"/)
  assert.match(link, /page=3[^>]*>; rel="next"/)
  assert.doesNotMatch(link, /consumer_/)
  assert.match(link, /status=processing/)
  assert.match(response.headers.get('access-control-expose-headers'), /Link/)
})

test("n8n's Return All loop collects every order through Link headers", async () => {
  const { emulator } = setup(250)
  const items = await fetchAllLikeN8n(emulator)
  assert.equal(items.length, 250)
  assert.equal(new Set(items.map((item) => item.id)).size, 250)
})

test('per_page defaults to 10 and invalid paging parameters return rest_invalid_param', async () => {
  const { emulator, calls } = setup(12)
  const response = await request(emulator, '/wc/v3/orders')
  assert.equal((await response.json()).length, 10)
  assert.equal(calls.at(-1).perPage, 10)
  for (const query of ['per_page=0', 'per_page=101', 'per_page=abc', 'page=0', 'offset=-1', 'orderby=price', 'order=sideways']) {
    const invalid = await request(emulator, '/wc/v3/orders', { query })
    assert.equal(invalid.status, 400, query)
    const body = await invalid.json()
    assert.equal(body.code, 'rest_invalid_param')
    assert.ok(Object.keys(body.data.params).length === 1)
  }
})

test('empty collections report zero total pages', async () => {
  const { emulator } = setup(0)
  const response = await request(emulator, '/wc/v3/orders')
  assert.equal(response.headers.get('x-wp-total'), '0')
  assert.equal(response.headers.get('x-wp-totalpages'), '0')
  assert.doesNotMatch(response.headers.get('link'), /rel="next"/)
})

test('offset is passed to the adapter and drives Airbyte-style paging', async () => {
  const { emulator, calls } = setup(150)
  const seen = new Set()
  for (let offset = 0; ; offset += 100) {
    const response = await request(emulator, '/wc/v3/orders', { query: `per_page=100&offset=${offset}&order=asc&orderby=id` })
    const rows = await response.json()
    rows.forEach((row) => seen.add(row.id))
    assert.equal(calls.at(-1).offset, offset)
    assert.equal(calls.at(-1).page, offset / 100 + 1)
    if (rows.length < 100) break
  }
  assert.equal(seen.size, 150)
})

test('include, exclude, status arrays, customer, product, and parent are parsed', async () => {
  const { emulator, calls } = setup(5)
  await request(emulator, '/wc/v3/orders', {
    query: 'include[]=1001&include[]=1002&exclude=1003,1004&status[]=processing&status[]=on-hold&customer=7&product=9&parent=3',
  })
  const params = calls.at(-1)
  assert.deepEqual(params.include, [1001, 1002])
  assert.deepEqual(params.exclude, [1003, 1004])
  assert.deepEqual(params.status, ['processing', 'on-hold'])
  assert.equal(params.customer, 7)
  assert.equal(params.product, 9)
  assert.deepEqual(params.parent, [3])
  await request(emulator, '/wc/v3/orders', { query: 'status=any' })
  assert.equal(calls.at(-1).status, undefined)
  assert.equal((await request(emulator, '/wc/v3/orders', { query: 'include=abc' })).status, 400)
})

test('date filters honor dates_are_gmt, explicit offsets, and the store time zone', async () => {
  const { emulator, calls } = setup(1)
  await request(emulator, '/wc/v3/orders', { query: 'after=2026-03-01T00:00:00&dates_are_gmt=true&modified_before=2026-03-01T10:00:00%2B02:00' })
  assert.equal(calls.at(-1).after, '2026-03-01T00:00:00.000Z')
  assert.equal(calls.at(-1).modifiedBefore, '2026-03-01T08:00:00.000Z')
  assert.equal((await request(emulator, '/wc/v3/orders', { query: 'after=yesterday' })).status, 400)
})

test('store time zone shifts wall-clock filters and plain date fields', async () => {
  const orders = [makeOrder(1, { createdAt: '2026-03-01T12:00:00Z', updatedAt: '2026-07-01T17:30:00Z' })]
  const { adapter, calls } = memoryAdapter(orders)
  const emulator = createWooEmulate({ store: { name: 'Example', url: origin, timezone: 'America/Chicago' }, auth, adapter })
  const response = await request(emulator, '/wc/v3/orders', { query: 'modified_after=2026-03-01T00:00:00&before=2026-07-01T00:00:00' })
  assert.equal(calls.at(-1).modifiedAfter, '2026-03-01T06:00:00.000Z') // CST, UTC-6
  assert.equal(calls.at(-1).before, '2026-07-01T05:00:00.000Z') // CDT, UTC-5
  const [order] = await response.json()
  assert.equal(order.date_created, '2026-03-01T06:00:00')
  assert.equal(order.date_created_gmt, '2026-03-01T12:00:00')
  assert.equal(order.date_modified, '2026-07-01T12:30:00')
  assert.equal(order.date_modified_gmt, '2026-07-01T17:30:00')
  assert.throws(() => createWooEmulate({ store: { name: 'x', url: origin, timezone: 'Mars/Base' }, auth, adapter }))
})

test('dates use the WooCommerce format without milliseconds or offsets', async () => {
  const orders = [makeOrder(1, { createdAt: new Date('2026-03-01T12:34:56.789Z'), updatedAt: '2026-03-02 08:00:00' })]
  const { adapter } = memoryAdapter(orders)
  const emulator = createWooEmulate({ store: { name: 'Example', url: origin }, auth, adapter })
  const order = await (await request(emulator, '/wc/v3/orders/1001')).json()
  assert.equal(order.date_created, '2026-03-01T12:34:56')
  assert.equal(order.date_created_gmt, '2026-03-01T12:34:56')
  assert.equal(order.date_modified_gmt, '2026-03-02T08:00:00')
  for (const key of Object.keys(order).filter((name) => name.startsWith('date_'))) {
    if (order[key] !== null) assert.match(order[key], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, key)
  }
})

test('PATCH, method overrides, and HEAD behave like WordPress', async () => {
  const { emulator, orders } = setup(2)
  const patched = await request(emulator, '/wc/v3/orders/1001', { method: 'PATCH', body: { status: 'on-hold' } })
  assert.equal(patched.status, 200)
  assert.equal(orders[0].status, 'on-hold')

  const viaQuery = await request(emulator, '/wc/v3/orders/1001?_method=PUT', { method: 'POST', body: { status: 'completed' } })
  assert.equal(viaQuery.status, 200)
  assert.equal(orders[0].status, 'completed')

  const viaHeader = await request(emulator, '/wc/v3/orders/1002', {
    method: 'POST', body: { status: 'cancelled' }, headers: { 'X-HTTP-Method-Override': 'PATCH' },
  })
  assert.equal(viaHeader.status, 200)
  assert.equal(orders[1].status, 'cancelled')

  const deleted = await request(emulator, '/wc/v3/orders/1001', { method: 'DELETE' })
  assert.equal(deleted.status, 404)
  assert.equal((await deleted.json()).code, 'rest_no_route')

  const head = await request(emulator, '/wc/v3/orders', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('x-wp-total'), '2')
  assert.equal(await head.text(), '')
})

test('invalid order statuses are rejected instead of being coerced', async () => {
  const { emulator, orders } = setup(1)
  const response = await request(emulator, '/wc/v3/orders/1001', { method: 'PUT', body: { status: 'shipped-ish' } })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).code, 'rest_invalid_param')
  assert.equal(orders[0].status, 'processing')
  const prefixed = await request(emulator, '/wc/v3/orders/1001', { method: 'PUT', body: { status: 'wc-completed' } })
  assert.equal(prefixed.status, 200)
  assert.equal(orders[0].status, 'completed')
})

test('authentication follows WooCommerce precedence, errors, and challenge headers', async () => {
  const { emulator } = setup(1)
  const wrongBasic = 'Basic ' + btoa('ck_wrong:cs_wrong')
  const queryWins = await request(emulator, '/wc/v3/orders', {
    headers: { Authorization: wrongBasic },
    query: `consumer_key=${auth.consumerKey}&consumer_secret=${auth.consumerSecret}`,
  })
  assert.equal(queryWins.status, 200)

  const badSecretBasic = await request(emulator, '/wc/v3/orders', { headers: { Authorization: 'Basic ' + btoa(`${auth.consumerKey}:nope`) } })
  assert.equal(badSecretBasic.status, 401)
  assert.equal((await badSecretBasic.json()).code, 'woocommerce_rest_authentication_error')
  assert.match(badSecretBasic.headers.get('www-authenticate'), /^Basic realm="WooCommerce API/)

  const badSecretQuery = await request(emulator, '/wc/v3/orders', { headers: { Authorization: '' }, query: `consumer_key=${auth.consumerKey}&consumer_secret=nope` })
  assert.equal(badSecretQuery.status, 401)
  assert.equal(badSecretQuery.headers.get('www-authenticate'), null)

  const unknownKey = await request(emulator, '/wc/v3/orders', { headers: { Authorization: wrongBasic } })
  assert.equal(unknownKey.status, 401)
  assert.deepEqual(await unknownKey.json(), { code: 'woocommerce_rest_cannot_view', message: 'Sorry, you cannot list resources.', data: { status: 401 } })

  const anonymousEdit = await request(emulator, '/wc/v3/orders/1001', { method: 'PUT', body: {}, headers: { Authorization: '' } })
  assert.equal((await anonymousEdit.json()).code, 'woocommerce_rest_cannot_edit')
})

test('namespace indexes are public and list only enabled routes', async () => {
  const { emulator } = setup(1)
  const v1 = await emulator.handleRequest(new Request(`${origin}/wp-json/wc/v1`))
  assert.equal(v1.status, 200)
  const body = await v1.json()
  assert.equal(body.namespace, 'wc/v1')
  assert.ok(body.routes['/wc/v1/orders'])
  assert.ok(body.routes['/wc/v1/reports/orders/totals'])
  const discovery = await (await emulator.handleRequest(new Request(`${origin}/wp-json`))).json()
  assert.deepEqual(discovery.namespaces, ['wc/v1', 'wc/v2', 'wc/v3', 'wc-shipment-tracking/v3', 'wc-ast/v3'])
  assert.deepEqual(discovery.routes['/wc/v3/orders/(?P<id>[\\d]+)'].methods, ['GET', 'POST', 'PUT', 'PATCH'])
  assert.deepEqual(discovery.authentication, [])
})

test('Advanced Shipment Tracking namespaces alias the tracking routes', async () => {
  const { emulator, orders } = setup(1)
  for (const namespace of ['wc-ast/v3', 'wc-shipment-tracking/v3', 'wc/v2']) {
    const created = await request(emulator, `/${namespace}/orders/1001/shipment-trackings`, {
      method: 'POST', body: { tracking_number: '1Z999AA10123456784', tracking_provider: 'UPS' },
    })
    assert.equal(created.status, 201, namespace)
    const record = await created.json()
    assert.equal(record._links.up[0].href, `${origin}/wp-json/${namespace}/orders/1001`)
  }
  assert.equal(orders[0].tracking.trackingNumber, '1Z999AA10123456784')
  const single = await request(emulator, '/wc-ast/v3/orders/1001/shipment-trackings/7')
  assert.equal((await single.json()).tracking_number, '1Z999AA10123456784')
  assert.equal((await request(emulator, '/wc-ast/v3/orders/1001/shipment-trackings/8')).status, 404)
  const providers = await (await request(emulator, '/wc/v3/orders/1001/shipment-trackings/providers')).json()
  assert.ok(providers['United States'].UPS)
  assert.equal((await request(emulator, '/wc-ast/v3/orders')).status, 404)
})

test('orders totals report counts each status through the adapter', async () => {
  const orders = [makeOrder(1), makeOrder(2, { status: 'completed' }), makeOrder(3, { status: 'completed' })]
  const { adapter } = memoryAdapter(orders)
  const emulator = createWooEmulate({ store: { name: 'Example', url: origin }, auth, adapter })
  const report = await (await request(emulator, '/wc/v3/reports/orders/totals')).json()
  assert.deepEqual(report.find((row) => row.slug === 'completed'), { slug: 'completed', name: 'Completed', total: 2 })
  assert.equal(report.find((row) => row.slug === 'processing').total, 1)
  assert.equal(report.find((row) => row.slug === 'pending').total, 0)
})

test('system_status/tools exists for connection checks', async () => {
  const { emulator } = setup(1)
  const response = await request(emulator, '/wc/v3/system_status/tools')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), [])
})

test('emptyCollections serve opt-in empty lists that still require authentication', async () => {
  const { emulator } = setup(1, { emptyCollections: ['products/categories'] })
  const ok = await request(emulator, '/wc/v3/products/categories')
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), [])
  assert.equal(ok.headers.get('x-wp-total'), '0')
  assert.equal((await request(emulator, '/wc/v3/products/categories', { headers: { Authorization: '' } })).status, 401)
  assert.equal((await request(emulator, '/wc/v3/products/tags')).status, 404)
  const { emulator: plain } = setup(1)
  assert.equal((await request(plain, '/wc/v3/products/categories')).status, 404)
})

test('the request observer reports routes and parameter names but never credential values', async () => {
  const events = []
  const { emulator } = setup(1, { onRequest: (event) => events.push(event) })
  await request(emulator, '/wc/v3/orders/1001', { query: `consumer_key=${auth.consumerKey}&consumer_secret=${auth.consumerSecret}&dp=2` })
  await request(emulator, '/wc/v3/unknown')
  assert.equal(events[0].route, '/wc/v3/orders/(?P<id>[\\d]+)')
  assert.equal(events[0].status, 200)
  assert.deepEqual(events[0].queryParams, ['consumer_key', 'consumer_secret', 'dp'])
  assert.doesNotMatch(JSON.stringify(events), /cs_fixture|ck_fixture/)
  assert.equal(events[1].status, 404)
  const { emulator: throwing } = setup(1, { onRequest: () => { throw new Error('observer failure') } })
  assert.equal((await request(throwing, '/wc/v3/orders')).status, 200)
})

test('basePath mounts keep Link and discovery URLs under the prefix', async () => {
  const { emulator } = setup(15, { basePath: '/shop' })
  const response = await emulator.handleRequest(new Request(`${origin}/shop/wp-json/wc/v3/orders`, { headers: { Authorization: basic } }))
  assert.equal(response.status, 200)
  assert.match(response.headers.get('link'), /^<https:\/\/store\.example\/shop\/wp-json\/>/)
  assert.match(response.headers.get('link'), /https:\/\/store\.example\/shop\/wp-json\/wc\/v3\/orders\?page=2/)
})

function authorizeUrl(params) {
  const url = new URL('/wc-auth/v1/authorize', origin)
  url.search = new URLSearchParams(params).toString()
  return url
}

const oauthParams = {
  app_name: 'Example app', scope: 'read_write', user_id: '42',
  callback_url: 'https://service.example/callback', return_url: 'http://service.example/done',
}

function oauthSetup(oauth = {}) {
  return setup(1, {
    oauth: {
      allowedCallbackUrls: ['https://service.example/callback'],
      allowedReturnUrls: ['http://service.example/done'],
      authorize: async () => true,
      ...oauth,
    },
  }).emulator
}

test('wc-auth requires every WooCommerce parameter', async () => {
  const emulator = oauthSetup()
  for (const missing of Object.keys(oauthParams)) {
    const params = { ...oauthParams }
    delete params[missing]
    const response = await emulator.handleRequest(new Request(authorizeUrl(params)))
    assert.equal(response.status, 400, missing)
    assert.match((await response.json()).message, new RegExp(missing))
  }
})

test('wc-auth accepts an allowlisted HTTP return URL and double-encoded callback', async () => {
  const emulator = oauthSetup()
  const consent = await emulator.handleRequest(new Request(authorizeUrl({
    ...oauthParams,
    callback_url: encodeURIComponent(oauthParams.callback_url),
  })))
  assert.equal(consent.status, 200)
  assert.match(await consent.text(), /Approve Connection/)
})

test('wc-auth redirects signed-out owners to the configured login page', async () => {
  const emulator = oauthSetup({ authorize: async () => false, loginUrl: (returnTo) => `/login?next=${encodeURIComponent(returnTo)}` })
  const response = await emulator.handleRequest(new Request(authorizeUrl(oauthParams)))
  assert.equal(response.status, 302)
  const location = new URL(response.headers.get('location'))
  assert.equal(location.origin + location.pathname, `${origin}/login`)
  assert.equal(new URL(location.searchParams.get('next')).pathname, '/wc-auth/v1/authorize')
  const post = await emulator.handleRequest(new Request(authorizeUrl(oauthParams), { method: 'POST', headers: { Origin: origin } }))
  assert.equal(post.status, 403)
})
