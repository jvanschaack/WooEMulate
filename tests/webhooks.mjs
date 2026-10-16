import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createWooEmulate, isSafeDeliveryUrl, serializeWcOrder } from '../dist/index.js'
import { auth, makeOrder, memoryAdapter, memoryWebhookStore, origin, recordingFetch, request } from './helpers.mjs'

function setup({ status = 200, webhooks = {} } = {}) {
  const orders = [makeOrder(1), makeOrder(2)]
  const { adapter } = memoryAdapter(orders)
  const store = memoryWebhookStore()
  const outbound = recordingFetch(status)
  const config = {
    store: { name: 'Example', url: origin }, auth, adapter,
    webhooks: { store, fetch: outbound.fetch, ...webhooks },
  }
  return { emulator: createWooEmulate(config), store, outbound, orders }
}

const hook = { topic: 'order.updated', delivery_url: 'https://hooks.example.net/woo' }

test('webhook routes are absent until a webhook store is configured', async () => {
  const { adapter } = memoryAdapter([makeOrder(1)])
  const emulator = createWooEmulate({ store: { name: 'Example', url: origin }, auth, adapter })
  assert.equal((await request(emulator, '/wc/v3/webhooks')).status, 404)
  assert.deepEqual(await emulator.webhooks.dispatch('order.updated', makeOrder(1)), [])
})

test("n8n's trigger flow: list active, create, receive a signed delivery, delete", async () => {
  const { emulator, outbound, orders } = setup()
  // n8n checks for an existing webhook before creating one.
  const existing = await request(emulator, '/wc/v3/webhooks', { query: 'status=active&per_page=100' })
  assert.deepEqual(await existing.json(), [])

  const secret = createHmac('md5', 'x').update('ck,cs').digest('hex')
  const created = await request(emulator, '/wc/v3/webhooks', { method: 'POST', body: { ...hook, secret } })
  assert.equal(created.status, 201)
  const webhook = await created.json()
  assert.equal(created.headers.get('location'), `${origin}/wp-json/wc/v3/webhooks/${webhook.id}`)
  assert.equal(webhook.status, 'active')
  assert.equal(webhook.resource, 'order')
  assert.equal(webhook.event, 'updated')
  assert.deepEqual(webhook.hooks, ['woocommerce_update_order', 'woocommerce_order_refunded'])
  assert.equal('secret' in webhook, false)

  // WooCommerce pings new active webhooks with an unsigned form body.
  assert.equal(outbound.calls.length, 1)
  assert.equal(outbound.calls[0].body, `webhook_id=${webhook.id}`)
  assert.equal(outbound.calls[0].headers.get('x-wc-webhook-id'), null)

  const [delivery] = await emulator.webhooks.dispatch('order.updated', orders[0])
  assert.equal(delivery.success, true)
  assert.equal(delivery.status, 200)
  const sent = outbound.calls[1]
  assert.equal(sent.url, hook.delivery_url)
  assert.equal(sent.init.redirect, 'manual')
  // Same verification n8n performs on incoming requests.
  assert.equal(sent.headers.get('x-wc-webhook-id'), String(webhook.id))
  assert.equal(sent.headers.get('x-wc-webhook-signature'), createHmac('sha256', secret).update(sent.body).digest('base64'))
  assert.equal(sent.headers.get('x-wc-webhook-topic'), 'order.updated')
  assert.equal(sent.headers.get('x-wc-webhook-resource'), 'order')
  assert.equal(sent.headers.get('x-wc-webhook-event'), 'updated')
  assert.equal(sent.headers.get('x-wc-webhook-source'), `${origin}/`)
  assert.match(sent.headers.get('x-wc-webhook-delivery-id'), /^[0-9a-f]{32}$/)
  assert.match(sent.headers.get('user-agent'), /^WooCommerce\/[\d.]+ Hookshot \(WordPress\/[\d.]+\)$/)
  assert.deepEqual(JSON.parse(sent.body), JSON.parse(JSON.stringify(serializeWcOrder(orders[0], { name: 'Example', url: origin }, { apiBase: `${origin}/wp-json/wc/v3` }))))

  assert.equal((await request(emulator, `/wc/v3/webhooks/${webhook.id}`, { method: 'DELETE' })).status, 501)
  const removed = await request(emulator, `/wc/v3/webhooks/${webhook.id}`, { method: 'DELETE', query: 'force=true' })
  assert.equal(removed.status, 200)
  assert.equal((await request(emulator, `/wc/v3/webhooks/${webhook.id}`)).status, 404)
})

test('payloads follow the namespace the webhook was created through', async () => {
  const { emulator, outbound, orders } = setup()
  await request(emulator, '/wc/v2/webhooks', { method: 'POST', body: hook })
  await request(emulator, '/wc/v1/webhooks', { method: 'POST', body: { ...hook, delivery_url: 'https://hooks.example.net/v1' } })
  orders[0].items[0].imageUrl = 'https://cdn.example/item.jpg'
  await emulator.webhooks.dispatch('order.updated', orders[0])
  const bodies = Object.fromEntries(outbound.calls.filter((call) => call.headers.get('x-wc-webhook-id')).map((call) => [call.url, JSON.parse(call.body)]))
  assert.equal(bodies[hook.delivery_url].line_items[0].image, undefined)
  assert.ok(bodies[hook.delivery_url].date_created_gmt)
  assert.equal(bodies['https://hooks.example.net/v1'].date_created_gmt, undefined)
})

test('dispatch targets only active webhooks for the topic and builds deleted and action payloads', async () => {
  const { emulator, store, outbound, orders } = setup()
  const make = async (body) => (await (await request(emulator, '/wc/v3/webhooks', { method: 'POST', body })).json()).id
  await make(hook)
  const paused = await make({ ...hook, delivery_url: 'https://hooks.example.net/paused' })
  await request(emulator, `/wc/v3/webhooks/${paused}`, { method: 'PUT', body: { status: 'paused' } })
  await make({ topic: 'order.deleted', delivery_url: 'https://hooks.example.net/deleted' })
  await make({ topic: 'action.woocommerce_order_status_processing', delivery_url: 'https://hooks.example.net/action' })
  assert.equal(store.rows.size, 4)
  outbound.calls.length = 0

  const updated = await emulator.webhooks.dispatch('order.updated', orders[0])
  assert.equal(updated.length, 1)
  await emulator.webhooks.dispatch('order.deleted', orders[1])
  await emulator.webhooks.dispatch('action.woocommerce_order_status_processing', orders[0])
  const byUrl = Object.fromEntries(outbound.calls.map((call) => [call.url, call]))
  assert.equal(byUrl['https://hooks.example.net/paused'], undefined)
  assert.deepEqual(JSON.parse(byUrl['https://hooks.example.net/deleted'].body), { id: 1002 })
  assert.deepEqual(JSON.parse(byUrl['https://hooks.example.net/action'].body), { action: 'woocommerce_order_status_processing', arg: 1001 })
  assert.equal(byUrl['https://hooks.example.net/action'].headers.get('x-wc-webhook-resource'), 'action')
  await assert.rejects(emulator.webhooks.dispatch('order.exploded', orders[0]), /Invalid webhook topic/)
})

test('failed deliveries are counted and disable the webhook after the limit', async () => {
  const { emulator, store, orders } = setup({ status: 500, webhooks: { maxDeliveryFailures: 2 } })
  const { id } = await (await request(emulator, '/wc/v3/webhooks', { method: 'POST', body: hook })).json()
  for (let attempt = 1; attempt <= 3; attempt++) {
    const [delivery] = await emulator.webhooks.dispatch('order.updated', orders[0])
    assert.equal(delivery.success, false)
    assert.equal(store.rows.get(id).failureCount, attempt)
    assert.equal(store.rows.get(id).status, 'active')
  }
  await emulator.webhooks.dispatch('order.updated', orders[0])
  assert.equal(store.rows.get(id).status, 'disabled')
  assert.deepEqual(await emulator.webhooks.dispatch('order.updated', orders[0]), [])

  // Reactivating resets the count, and a success keeps it at zero.
  await request(emulator, `/wc/v3/webhooks/${id}`, { method: 'PATCH', body: { status: 'active' } })
  assert.equal(store.rows.get(id).failureCount, 0)
})

test('successful deliveries reset the failure count; redirects up to 302 count as success', async () => {
  let status = 500
  const { emulator, store, orders } = setup({ status: () => status })
  const { id } = await (await request(emulator, '/wc/v3/webhooks', { method: 'POST', body: hook })).json()
  await emulator.webhooks.dispatch('order.updated', orders[0])
  assert.equal(store.rows.get(id).failureCount, 1)
  status = 302
  const [delivery] = await emulator.webhooks.dispatch('order.updated', orders[0])
  assert.equal(delivery.success, true)
  assert.equal(store.rows.get(id).failureCount, 0)
})

test('delivery URLs are validated against the SSRF policy', async () => {
  const { emulator, store, outbound, orders } = setup()
  for (const url of ['ftp://hooks.example.net', 'not a url', 'http://hooks.example.net/woo', 'https://127.0.0.1/x', 'https://localhost/x',
    'https://10.1.2.3/x', 'https://192.168.0.5/x', 'https://169.254.169.254/latest', 'https://[::1]/x', 'https://intranet/x',
    'https://service.internal/x', 'https://2130706433/x', 'https://user:pass@hooks.example.net/x']) {
    const response = await request(emulator, '/wc/v3/webhooks', { method: 'POST', body: { topic: 'order.created', delivery_url: url } })
    assert.equal(response.status, 400, url)
    assert.equal((await response.json()).code, 'woocommerce_rest_webhook_invalid_delivery_url')
  }
  assert.equal(isSafeDeliveryUrl(new URL('https://hooks.example.net/woo')), true)
  // A URL stored outside the API is still checked at delivery time.
  await store.createWebhook({ name: 'x', status: 'active', topic: 'order.created', deliveryUrl: 'https://127.0.0.1/x', secret: 's', apiVersion: 'wp_api_v3', failureCount: 0 })
  const [blocked] = await emulator.webhooks.dispatch('order.created', orders[0])
  assert.equal(blocked.success, false)
  assert.equal(blocked.status, null)
  assert.equal(outbound.calls.length, 0)

  const local = setup({ webhooks: { validateDeliveryUrl: (url) => url.hostname === 'localhost' } })
  const allowed = await request(local.emulator, '/wc/v3/webhooks', { method: 'POST', body: { topic: 'order.created', delivery_url: 'http://localhost:5678/webhook' } })
  assert.equal(allowed.status, 201)
})

test('topics are validated like WooCommerce', async () => {
  const { emulator } = setup()
  for (const topic of [undefined, 'order', 'order.exploded', 'customer.restored', 'action.do_evil', 'refund.created']) {
    const response = await request(emulator, '/wc/v3/webhooks', { method: 'POST', body: { ...hook, topic } })
    assert.equal(response.status, 400, String(topic))
    assert.equal((await response.json()).code, 'woocommerce_rest_webhook_invalid_topic')
  }
  for (const topic of ['coupon.restored', 'customer.deleted', 'product.created', 'action.wc_custom_event']) {
    assert.equal((await request(emulator, '/wc/v3/webhooks', { method: 'POST', body: { ...hook, topic } })).status, 201, topic)
  }
})

test('listing supports status filters, search, and pagination headers', async () => {
  const { emulator } = setup()
  for (let i = 0; i < 12; i++) {
    await request(emulator, '/wc/v3/webhooks', { method: 'POST', body: { ...hook, name: `Hook ${i}`, status: i % 2 ? 'paused' : 'active' } })
  }
  const page = await request(emulator, '/wc/v3/webhooks', { query: 'per_page=5&status=active&orderby=id&order=asc' })
  assert.equal(page.headers.get('x-wp-total'), '6')
  assert.equal(page.headers.get('x-wp-totalpages'), '2')
  assert.deepEqual((await page.json()).map((row) => row.name), ['Hook 0', 'Hook 2', 'Hook 4', 'Hook 6', 'Hook 8'])
  const search = await (await request(emulator, '/wc/v3/webhooks', { query: 'search=Hook 11' })).json()
  assert.deepEqual(search.map((row) => row.name), ['Hook 11'])
})

test('batch creates, updates, and deletes with per-item errors', async () => {
  const { emulator, store } = setup()
  const { id } = await (await request(emulator, '/wc/v3/webhooks', { method: 'POST', body: hook })).json()
  const response = await request(emulator, '/wc/v3/webhooks/batch', {
    method: 'POST',
    body: {
      create: [{ ...hook, name: 'Batch A' }, { topic: 'bogus', delivery_url: hook.delivery_url }],
      update: [{ id, name: 'Renamed' }, { id: 999, name: 'Missing' }],
      delete: [id],
    },
  })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.create[0].name, 'Batch A')
  assert.equal(result.create[1].id, 0)
  assert.equal(result.create[1].error.code, 'woocommerce_rest_webhook_invalid_topic')
  assert.equal(result.update[0].name, 'Renamed')
  assert.equal(result.update[1].error.code, 'woocommerce_rest_shop_webhook_invalid_id')
  assert.equal(result.delete[0].id, id)
  assert.equal(store.rows.has(id), false)
  const tooMany = await request(emulator, '/wc/v3/webhooks/batch', { method: 'POST', body: { delete: Array.from({ length: 101 }, (_, i) => i + 1) } })
  assert.equal(tooMany.status, 413)
})

test('pings run through waitUntil when the host provides one', async () => {
  const { emulator, outbound } = setup()
  const pending = []
  const response = await emulator.handleRequest(new Request(`${origin}/wp-json/wc/v3/webhooks`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`${auth.consumerKey}:${auth.consumerSecret}`), 'Content-Type': 'application/json' },
    body: JSON.stringify(hook),
  }), { waitUntil: (promise) => pending.push(promise) })
  assert.equal(response.status, 201)
  assert.equal(pending.length, 1)
  await Promise.all(pending)
  assert.equal(outbound.calls.length, 1)
})
