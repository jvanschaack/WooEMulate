import test from 'node:test'
import assert from 'node:assert/strict'
import { createWooEmulate, parseTrackingFromNote, serializeWcOrder } from '../dist/index.js'
import { auth, makeOrder, memoryAdapter, origin, request } from './helpers.mjs'

function notesSetup(extra = {}) {
  const orders = [makeOrder(1)]
  const { adapter } = memoryAdapter(orders)
  const notes = [
    { id: 11, note: 'Order status changed from Pending to Processing.', customerNote: false, createdAt: '2026-01-01T01:00:00Z' },
    { id: 12, note: 'Thanks for your order!', customerNote: true, author: 'Store Owner', createdAt: '2026-01-01T02:00:00Z' },
  ]
  const tracking = []
  const deleted = []
  adapter.listOrderNotes = async (orderId) => (orderId === 'ord_1' ? notes : [])
  adapter.createOrderNote = async (orderId, input) => {
    const note = { id: 100 + notes.length, note: input.note, customerNote: input.customerNote, createdAt: '2026-01-02T00:00:00Z' }
    notes.push(note)
    return note
  }
  adapter.deleteOrderNote = async (orderId, noteId) => { deleted.push({ orderId, noteId }) }
  adapter.onShipmentTrackingCreated = async (orderId, payload) => { tracking.push({ orderId, ...payload }); return { id: 1 } }
  const emulator = createWooEmulate({ store: { name: 'Example', url: origin }, auth, adapter, ...extra })
  return { emulator, notes, tracking, deleted, orders }
}

test('notes routes exist only when the adapter implements them', async () => {
  const { adapter } = memoryAdapter([makeOrder(1)])
  const emulator = createWooEmulate({ store: { name: 'Example', url: origin }, auth, adapter })
  const response = await request(emulator, '/wc/v3/orders/1001/notes')
  assert.equal(response.status, 404)
  assert.equal((await response.json()).code, 'rest_no_route')
  const discovery = await (await emulator.handleRequest(new Request(`${origin}/wp-json`))).json()
  assert.equal(discovery.routes['/wc/v3/orders/(?P<order_id>[\\d]+)/notes'], undefined)
})

test('notes list, filter by type, and match each API version shape', async () => {
  const { emulator } = notesSetup()
  const all = await (await request(emulator, '/wc/v3/orders/1001/notes')).json()
  assert.equal(all.length, 2)
  assert.deepEqual(Object.keys(all[0]), ['id', 'author', 'date_created', 'date_created_gmt', 'note', 'customer_note', '_links'])
  assert.equal(all[0].author, 'system')
  assert.equal(all[1].author, 'Store Owner')
  assert.equal(all[0].date_created_gmt, '2026-01-01T01:00:00')
  assert.equal(all[0]._links.up[0].href, `${origin}/wp-json/wc/v3/orders/1001`)

  const customer = await (await request(emulator, '/wc/v3/orders/1001/notes', { query: 'type=customer' })).json()
  assert.deepEqual(customer.map((note) => note.id), [12])
  const internal = await (await request(emulator, '/wc/v3/orders/1001/notes', { query: 'type=internal' })).json()
  assert.deepEqual(internal.map((note) => note.id), [11])
  assert.equal((await request(emulator, '/wc/v3/orders/1001/notes', { query: 'type=secret' })).status, 400)

  const v2 = await (await request(emulator, '/wc/v2/orders/1001/notes')).json()
  assert.equal(v2[0].author, undefined)
  assert.ok(v2[0].date_created_gmt)
  const v1 = await (await request(emulator, '/wc/v1/orders/1001/notes')).json()
  assert.deepEqual(Object.keys(v1[0]), ['id', 'date_created', 'note', 'customer_note', '_links'])
})

test('creating a note returns 201 with Location and validates input', async () => {
  const { emulator, notes } = notesSetup()
  const response = await request(emulator, '/wc/v3/orders/1001/notes', {
    method: 'POST', body: { note: 'Shipped via USPS', customer_note: 'true' },
  })
  assert.equal(response.status, 201)
  const created = await response.json()
  assert.equal(created.customer_note, true)
  assert.equal(response.headers.get('location'), `${origin}/wp-json/wc/v3/orders/1001/notes/${created.id}`)
  assert.equal(notes.at(-1).note, 'Shipped via USPS')

  const missing = await request(emulator, '/wc/v3/orders/1001/notes', { method: 'POST', body: { customer_note: true } })
  assert.equal(missing.status, 400)
  assert.equal((await missing.json()).code, 'rest_missing_callback_param')
  const badOrder = await request(emulator, '/wc/v3/orders/9999/notes', { method: 'POST', body: { note: 'x' } })
  assert.equal(badOrder.status, 404)
  assert.equal((await badOrder.json()).code, 'woocommerce_rest_order_invalid_id')
})

test('single notes and deletion follow WooCommerce force semantics', async () => {
  const { emulator, deleted } = notesSetup()
  assert.equal((await (await request(emulator, '/wc/v3/orders/1001/notes/12')).json()).note, 'Thanks for your order!')
  assert.equal((await request(emulator, '/wc/v3/orders/1001/notes/99')).status, 404)
  const trash = await request(emulator, '/wc/v3/orders/1001/notes/12', { method: 'DELETE' })
  assert.equal(trash.status, 501)
  assert.equal(deleted.length, 0)
  const removed = await request(emulator, '/wc/v3/orders/1001/notes/12', { method: 'DELETE', query: 'force=true' })
  assert.equal(removed.status, 200)
  assert.equal((await removed.json()).id, 12)
  assert.deepEqual(deleted, [{ orderId: 'ord_1', noteId: 12 }])
})

test('trackingFromNotes turns tracking notes into structured tracking only when enabled', async () => {
  const note = 'Your order shipped! USPS tracking number: 9400 1118 9956 2537 6251 23'
  const off = notesSetup()
  await request(off.emulator, '/wc/v3/orders/1001/notes', { method: 'POST', body: { note } })
  assert.equal(off.tracking.length, 0)

  const on = notesSetup({ trackingFromNotes: true })
  await request(on.emulator, '/wc/v3/orders/1001/notes', { method: 'POST', body: { note } })
  assert.equal(on.tracking.length, 1)
  assert.equal(on.tracking[0].orderId, 'ord_1')
  assert.equal(on.tracking[0].trackingNumber, '9400111899562537625123')
  assert.equal(on.tracking[0].carrier, 'USPS')
  await request(on.emulator, '/wc/v3/orders/1001/notes', { method: 'POST', body: { note: 'Gift wrap requested' } })
  assert.equal(on.tracking.length, 1)
})

test('parseTrackingFromNote handles links, labels, bare numbers, and HTML', () => {
  assert.deepEqual(
    parseTrackingFromNote('Tracking: <a href="https://www.ups.com/track?tracknum=1Z999AA10123456784&amp;loc=en_US">track</a>'),
    { trackingNumber: '1Z999AA10123456784', carrier: 'UPS', trackingUrl: 'https://www.ups.com/track?tracknum=1Z999AA10123456784&loc=en_US' }
  )
  const fedex = parseTrackingFromNote('Shipped with FedEx Ground. Tracking #: 123456789012')
  assert.equal(fedex.trackingNumber, '123456789012')
  assert.equal(fedex.carrier, 'FedEx')
  assert.match(fedex.trackingUrl, /fedex\.com/)
  const bare = parseTrackingFromNote('Label created 1Z999AA10123456784 today')
  assert.equal(bare.trackingNumber, '1Z999AA10123456784')
  assert.equal(bare.carrier, 'UPS')
  const royal = parseTrackingFromNote('Sent by Royal Mail, ref RR123456785GB')
  assert.equal(royal.trackingNumber, 'RR123456785GB')
  assert.equal(royal.carrier, 'Royal Mail')
  assert.equal(royal.trackingUrl, undefined)
  assert.equal(parseTrackingFromNote('Customer asked for gift wrap on 2026-01-02'), null)
  assert.equal(parseTrackingFromNote(''), null)
})

const richOrder = {
  ...makeOrder(5),
  status: 'completed',
  customerId: 77,
  parentId: 0,
  orderKey: 'wc_order_abc',
  createdVia: 'admin',
  totalCents: 3190,
  shippingTaxCents: 40,
  taxCents: 240,
  discountCents: 500,
  discountTaxCents: 0,
  paidAt: '2026-01-01T06:00:00Z',
  completedAt: '2026-01-03T00:00:00Z',
  billingAddress: { firstName: 'Mary Ann', lastName: 'Smith', address1: '9 Billing Rd', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US', email: 'mary@example.com' },
  items: [
    { id: 41, name: 'Tee - Blue / L', sku: 'TEE-BL-L', quantity: 2, unitPriceCents: 1500, subtotalCents: 3000, totalPriceCents: 2500, taxCents: 200, subtotalTaxCents: 240, productId: 300, variationId: 301, parentName: 'Tee', imageUrl: 'https://cdn.example/tee.jpg', taxes: [{ rateId: 1, totalCents: 200, subtotalCents: 240 }], metadata: { pa_size: 'L' } },
  ],
  taxLines: [{ rateId: 1, rateCode: 'US-TX-STATE TAX-1', label: 'State Tax', taxCents: 200, shippingTaxCents: 40, ratePercent: 8.25 }],
  shippingLines: [{ methodTitle: 'USPS Ground Advantage', methodId: 'usps', instanceId: '3', totalCents: 450, taxCents: 40, taxes: [{ rateId: 1, totalCents: 40 }] }],
  feeLines: [{ name: 'Handling', totalCents: 0 }],
  couponLines: [{ code: 'save5', discountCents: 500 }],
  refunds: [{ id: 900, reason: 'Damaged', totalCents: 1000 }],
}

test('orders serialize real tax, shipping, fee, coupon, refund, and product data', () => {
  const order = serializeWcOrder(richOrder, { name: 'Example', url: origin }, { apiBase: `${origin}/wp-json/wc/v3` })
  assert.equal(order.customer_id, 77)
  assert.equal(order.order_key, 'wc_order_abc')
  assert.equal(order.created_via, 'admin')
  assert.equal(order.cart_tax, '2.00')
  assert.equal(order.shipping_tax, '0.40')
  assert.equal(order.total_tax, '2.40')
  assert.equal(order.shipping_total, '4.50')
  assert.equal(order.discount_total, '5.00')
  assert.equal(order.date_paid_gmt, '2026-01-01T06:00:00')
  assert.equal(order.date_completed_gmt, '2026-01-03T00:00:00')
  assert.equal(order.currency_symbol, '$')
  assert.deepEqual(order.line_items[0], {
    id: 41, name: 'Tee - Blue / L', product_id: 300, variation_id: 301, quantity: 2, tax_class: '',
    subtotal: '30.00', subtotal_tax: '2.40', total: '25.00', total_tax: '2.00',
    taxes: [{ id: 1, total: '2.00', subtotal: '2.40' }], meta_data: [{ key: 'pa_size', value: 'L' }],
    sku: 'TEE-BL-L', price: 12.5, image: { id: '', src: 'https://cdn.example/tee.jpg' }, parent_name: 'Tee', weight: undefined,
  })
  assert.deepEqual(order.tax_lines[0], {
    id: 1, rate_code: 'US-TX-STATE TAX-1', rate_id: 1, label: 'State Tax', compound: false,
    tax_total: '2.00', shipping_tax_total: '0.40', rate_percent: 8.25, meta_data: [],
  })
  assert.equal(order.shipping_lines[0].method_title, 'USPS Ground Advantage')
  assert.deepEqual(order.shipping_lines[0].taxes, [{ id: 1, total: '0.40', subtotal: '' }])
  assert.equal(order.fee_lines[0].name, 'Handling')
  assert.deepEqual(order.coupon_lines[0], { id: 1, code: 'save5', discount: '5.00', discount_tax: '0.00', meta_data: [] })
  assert.deepEqual(order.refunds, [{ id: 900, reason: 'Damaged', total: '-10.00' }])
  assert.equal(order.billing.first_name, 'Mary Ann')
  assert.equal(order.billing.last_name, 'Smith')
  assert.equal(order.billing.email, 'mary@example.com')
  assert.equal('email' in order.shipping, false)
  assert.equal(order._links.customer[0].href, `${origin}/wp-json/wc/v3/customers/77`)
})

test('missing product IDs, payment dates, and countries use WooCommerce-compatible defaults', () => {
  const store = { name: 'Example', url: origin }
  const pending = serializeWcOrder({ ...makeOrder(1), status: 'pending', shippingAddress: { firstName: 'Ann', address1: '1 St', city: 'X', state: 'TX', postalCode: '1' } }, store)
  assert.equal(pending.date_paid, null)
  assert.equal(pending.needs_payment, true)
  assert.equal(pending.is_editable, true)
  assert.equal(pending.line_items[0].product_id, 0)
  assert.equal(pending.shipping.country, 'US')
  const processing = serializeWcOrder(makeOrder(2), store)
  assert.equal(processing.date_paid_gmt, processing.date_created_gmt)
  assert.equal(processing.date_completed, null)
  const shipped = serializeWcOrder({ ...makeOrder(3), status: 'completed', tracking: { trackingNumber: '1', dateShipped: '2026-02-02' } }, store)
  assert.equal(shipped.date_completed_gmt, '2026-02-02T00:00:00')
  const withoutTaxLines = serializeWcOrder({ ...makeOrder(4), taxCents: 150 }, store)
  assert.equal(withoutTaxLines.cart_tax, '1.50')
  assert.equal(withoutTaxLines.total_tax, '1.50')
  assert.equal(serializeWcOrder(makeOrder(4), store, { dp: 3 }).total, '10.040')
})

test('v1 and v2 order routes return their own schema', async () => {
  const { adapter } = memoryAdapter([richOrder])
  const emulator = createWooEmulate({ store: { name: 'Example', url: origin }, auth, adapter })
  const v2 = await (await request(emulator, '/wc/v2/orders/1005')).json()
  assert.equal(v2.line_items[0].image, undefined)
  assert.equal(v2.line_items[0].parent_name, undefined)
  assert.ok(v2.date_created_gmt)
  assert.ok(Array.isArray(v2.meta_data))

  const v1 = await (await request(emulator, '/wc/v1/orders/1005')).json()
  assert.equal(v1.date_created_gmt, undefined)
  assert.equal(v1.date_created, v2.date_created_gmt)
  assert.equal(v1.meta_data, undefined)
  assert.equal(v1.line_items[0].price, '12.50')
  assert.deepEqual(v1.line_items[0].meta, [{ key: 'pa_size', label: 'pa_size', value: 'L' }])
  assert.equal(v1.line_items[0].meta_data, undefined)
  assert.equal(v1._links.self[0].href, `${origin}/wp-json/wc/v1/orders/1005`)

  const v3 = await (await request(emulator, '/wc/v3/orders/1005', { query: 'dp=0' })).json()
  assert.equal(v3.total, '32')
})
