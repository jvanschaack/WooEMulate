import test from 'node:test'
import assert from 'node:assert/strict'
import { createWooEmulate } from '../dist/index.js'

// In-memory test store
const mockOrders = [
  {
    id: 'ord_sample_9852',
    wooCommerceId: 9852,
    orderNumber: 'STORE-9852',
    status: 'processing',
    createdAt: '2026-03-01T12:00:00Z',
    totalCents: 4999,
    subtotalCents: 4500,
    shippingCents: 499,
    taxCents: 0,
    discountCents: 0,
    currency: 'USD',
    customer: {
      name: 'Jane Doe',
      email: 'jane@example.com',
      phone: '555-123-4567',
    },
    shippingAddress: {
      firstName: 'Jane',
      lastName: 'Doe',
      address1: '123 Market Street',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'US',
    },
    items: [
      {
        id: 1,
        name: 'Artisan Coffee Blend',
        sku: 'COF-001',
        quantity: 2,
        unitPriceCents: 2250,
        totalPriceCents: 4500,
        weightLb: 1.5,
        dimensionsIn: { length: 8, width: 6, height: 4 },
      },
    ],
    tracking: undefined,
  },
]

let lastCreatedTracking = null
let lastStatusUpdate = null

const emulator = createWooEmulate({
  store: {
    name: 'Sample Coffee Co.',
    url: 'https://examplecoffee.com',
    currency: 'USD',
  },
  auth: {
    consumerKey: 'ck_test_123',
    consumerSecret: 'cs_test_456',
  },
  adapter: {
    async listOrders({ status }) {
      let filtered = mockOrders
      if (status && status !== 'any') {
        filtered = mockOrders.filter((o) => o.status === status)
      }
      return {
        orders: filtered,
        totalCount: filtered.length,
      }
    },
    async getOrder(idOrNumber) {
      return (
        mockOrders.find(
          (o) =>
            o.id === idOrNumber ||
            o.orderNumber === idOrNumber
        ) || null
      )
    },
    async getOrderByWooCommerceId(id) {
      return mockOrders.find((order) => order.wooCommerceId === id) || null
    },
    async updateOrderStatus(id, status) {
      lastStatusUpdate = { id, status }
      const o = mockOrders.find((ord) => ord.id === id)
      if (o) o.status = status
    },
    async onShipmentTrackingCreated(orderId, tracking) {
      lastCreatedTracking = { orderId, ...tracking }
      const o = mockOrders.find((ord) => ord.id === orderId)
      if (o) {
        o.tracking = { id: 101, ...tracking }
      }
      return { id: 101 }
    },
  },
})

test('1. Discovery root /wp-json returns 200 and advertised routes', async () => {
  const req = new Request('https://examplecoffee.com/wp-json')
  const res = await emulator.handleRequest(req)

  assert.equal(res.status, 200)
  const json = await res.json()
  assert.equal(json.name, 'Sample Coffee Co.')
  assert.ok(json.namespaces.includes('wc/v3'))
  assert.ok(json.routes['/wc/v3/orders'])
})

test('2. Unauthenticated request to /orders returns 401', async () => {
  const req = new Request('https://examplecoffee.com/wp-json/wc/v3/orders')
  const res = await emulator.handleRequest(req)

  assert.equal(res.status, 401)
  const json = await res.json()
  assert.equal(json.code, 'woocommerce_rest_cannot_view')
})

test('3. Query Parameter Authentication works', async () => {
  const req = new Request(
    'https://examplecoffee.com/wp-json/wc/v3/orders?consumer_key=ck_test_123&consumer_secret=cs_test_456'
  )
  const res = await emulator.handleRequest(req)

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('X-WP-Total'), '1')
  const orders = await res.json()
  assert.equal(orders.length, 1)

  const order = orders[0]
  assert.equal(order.number, 'STORE-9852')
  assert.equal(typeof order.id, 'number') // Must be numeric!
  assert.equal(order.status, 'processing')
  assert.equal(order.shipping.city, 'Austin')
  assert.equal(order.line_items[0].name, 'Artisan Coffee Blend')

  // Check calculated parcel weight (1.5 lb * 2 = 3.00 lb)
  const weightMeta = order.meta_data.find((m) => m.key === '_shipping_weight')
  assert.ok(weightMeta)
  assert.equal(weightMeta.value, '3.00')

  // Check bounding dimensions
  const lenMeta = order.meta_data.find((m) => m.key === '_package_length')
  assert.equal(lenMeta.value, '8.0')
})

test('4. HTTP Basic Auth works', async () => {
  const credentials = Buffer.from('ck_test_123:cs_test_456').toString('base64')
  const req = new Request('https://examplecoffee.com/wp-json/wc/v3/orders', {
    headers: {
      Authorization: `Basic ${credentials}`,
    },
  })
  const res = await emulator.handleRequest(req)

  assert.equal(res.status, 200)
  const orders = await res.json()
  assert.equal(orders.length, 1)
})

test('5. Single order fetch /orders/:id', async () => {
  const req = new Request(
    'https://examplecoffee.com/wp-json/wc/v3/orders/9852?consumer_key=ck_test_123&consumer_secret=cs_test_456'
  )
  const res = await emulator.handleRequest(req)

  assert.equal(res.status, 200)
  const order = await res.json()
  assert.equal(order.number, 'STORE-9852')
})

test('6. POST shipment-trackings saves tracking and updates status', async () => {
  const trackingPayload = {
    tracking_number: '9400111899562537625123',
    tracking_provider: 'USPS',
    date_shipped: '2026-03-02',
  }

  const req = new Request(
    'https://examplecoffee.com/wp-json/wc/v3/orders/9852/shipment-trackings?consumer_key=ck_test_123&consumer_secret=cs_test_456',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(trackingPayload),
    }
  )

  const res = await emulator.handleRequest(req)
  assert.equal(res.status, 201)

  const trackingJson = await res.json()
  assert.equal(trackingJson.tracking_id, 101)
  assert.equal(trackingJson.tracking_number, '9400111899562537625123')
  assert.equal(trackingJson.tracking_provider, 'USPS')

  assert.equal(lastCreatedTracking?.orderId, 'ord_sample_9852')
  assert.equal(lastStatusUpdate?.status, 'completed')
})

test('7. System Status report /system_status', async () => {
  const req = new Request(
    'https://examplecoffee.com/wp-json/wc/v3/system_status?consumer_key=ck_test_123&consumer_secret=cs_test_456'
  )
  const res = await emulator.handleRequest(req)

  assert.equal(res.status, 200)
  const json = await res.json()
  assert.ok(json.environment)
  assert.ok(json.active_plugins.some((p) => p.plugin.includes('shipment-tracking')))
})

test('8. OPTIONS preflight returns 204 with CORS', async () => {
  const req = new Request('https://examplecoffee.com/wp-json/wc/v3/orders', {
    method: 'OPTIONS',
  })
  const res = await emulator.handleRequest(req)

  assert.equal(res.status, 204)
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*')
})
