import test from 'node:test'
import assert from 'node:assert/strict'
import { createWooEmulate } from '../dist/index.js'
import { auth, makeOrder, memoryAdapter, memoryCatalog, memoryWebhookStore, origin, recordingFetch, request } from './helpers.mjs'

function setup(catalogOverrides = {}, extra = {}) {
  const { adapter } = memoryAdapter([makeOrder(1)])
  const memory = memoryCatalog()
  adapter.products = { ...memory.catalog, ...catalogOverrides }
  for (const [key, value] of Object.entries(catalogOverrides)) if (value === undefined) delete adapter.products[key]
  const emulator = createWooEmulate({ store: { name: 'Example', url: origin }, auth, adapter, ...extra })
  return { emulator, ...memory }
}

test('product routes are absent without a products adapter', async () => {
  const { adapter } = memoryAdapter([makeOrder(1)])
  const emulator = createWooEmulate({ store: { name: 'Example', url: origin }, auth, adapter })
  for (const path of ['/products', '/products/300', '/products/categories', '/products/300/variations']) {
    assert.equal((await request(emulator, `/wc/v3${path}`)).status, 404, path)
  }
})

test('products list with WooCommerce filters, pagination, and shape', async () => {
  const { emulator, calls } = setup()
  const response = await request(emulator, '/wc/v3/products', {
    query: 'per_page=1&sku=TEE,MUG&status=publish&type=variable&category=5&tag=9&stock_status=instock&min_price=10.50&on_sale=false&modified_after=2026-01-01T00:00:00',
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-wp-total'), '2')
  assert.match(response.headers.get('link'), /rel="next"/)
  const params = calls.list.at(-1)
  assert.deepEqual(params.sku, ['TEE', 'MUG'])
  assert.equal(params.status, 'publish')
  assert.equal(params.type, 'variable')
  assert.equal(params.category, 5)
  assert.equal(params.tag, 9)
  assert.equal(params.stockStatus, 'instock')
  assert.equal(params.minPriceCents, 1050)
  assert.equal(params.onSale, false)
  assert.equal(params.modifiedAfter, '2026-01-01T00:00:00.000Z')

  const [tee] = await response.json()
  assert.equal(tee.id, 300)
  assert.equal(tee.type, 'variable')
  assert.equal(tee.slug, 'logo-tee')
  assert.equal(tee.price, '20.00')
  assert.equal(tee.regular_price, '20.00')
  assert.equal(tee.sale_price, '')
  assert.equal(tee.weight, '0.5')
  assert.deepEqual(tee.dimensions, { length: '10', width: '8', height: '1' })
  assert.deepEqual(tee.variations, [301, 302])
  assert.deepEqual(tee.categories, [{ id: 5, name: 'Apparel', slug: 'apparel' }])
  assert.equal(tee.images[0].src, 'https://cdn.example/tee.jpg')
  assert.equal(tee.attributes[0].variation, true)
  assert.equal(tee.manage_stock, false)
  assert.equal(tee.stock_status, 'instock')
  assert.equal(tee.date_modified_gmt, '2026-01-05T00:00:00')
  assert.equal(tee._links.self[0].href, `${origin}/wp-json/wc/v3/products/300`)

  for (const query of ['type=bundle', 'stock_status=maybe', 'min_price=cheap', 'orderby=color']) {
    assert.equal((await request(emulator, '/wc/v3/products', { query })).status, 400, query)
  }
})

test('stock status and sale pricing are derived like WooCommerce', async () => {
  const { emulator } = setup()
  const mug = await (await request(emulator, '/wc/v3/products/400')).json()
  assert.equal(mug.on_sale, true)
  assert.equal(mug.price, '12.00')
  assert.equal(mug.manage_stock, true)
  assert.equal(mug.stock_quantity, 0)
  assert.equal(mug.stock_status, 'outofstock')
  const v2 = await (await request(emulator, '/wc/v2/products/400')).json()
  assert.equal(v2.in_stock, false)
  assert.equal((await request(emulator, '/wc/v3/products/999')).status, 404)
  assert.equal((await (await request(emulator, '/wc/v3/products/999')).json()).code, 'woocommerce_rest_product_invalid_id')
})

test('a lookup returning another product never exposes it', async () => {
  const { emulator } = setup({ getProduct: async () => ({ id: 'other', wooCommerceId: 401, name: 'Other' }) })
  assert.equal((await request(emulator, '/wc/v3/products/400')).status, 404)
})

test('stock and price updates reach the adapter; echoed fields are accepted', async () => {
  const { emulator, calls, products } = setup()
  const current = await (await request(emulator, '/wc/v3/products/400')).json()
  const response = await request(emulator, '/wc/v3/products/400', {
    method: 'PUT',
    body: { ...current, stock_quantity: 12, manage_stock: true, regular_price: '16.99', sale_price: '' },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(calls.updates.at(-1), {
    product: 'prod_mug',
    // manage_stock and stock_status repeat current values, so they are not sent as changes.
    changes: { stockQuantity: 12, regularPriceCents: 1699, salePriceCents: null },
  })
  const body = await response.json()
  assert.equal(body.stock_quantity, 12)
  assert.equal(body.stock_status, 'instock')
  assert.equal(body.price, '16.99')
  assert.equal(products[1].stockQuantity, 12)
})

test('changes outside stock and price are rejected without writing', async () => {
  const { emulator, calls } = setup()
  const response = await request(emulator, '/wc/v3/products/400', { method: 'PATCH', body: { name: 'Renamed', stock_quantity: 3 } })
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.equal(body.code, 'rest_invalid_param')
  assert.deepEqual(Object.keys(body.data.params), ['name'])
  assert.equal(calls.updates.length, 0)
  assert.equal((await request(emulator, '/wc/v3/products/400', { method: 'PUT', body: { stock_quantity: 'many' } })).status, 400)
  assert.equal((await request(emulator, '/wc/v3/products/400', { method: 'PUT', body: { regular_price: '-1' } })).status, 400)
})

test('write routes exist only with update hooks; creation is never routed', async () => {
  const { emulator } = setup({ updateProduct: undefined, updateVariation: undefined })
  assert.equal((await request(emulator, '/wc/v3/products/400', { method: 'PUT', body: { stock_quantity: 1 } })).status, 404)
  assert.equal((await request(emulator, '/wc/v3/products', { method: 'POST', body: { name: 'New' } })).status, 404)
  assert.equal((await request(emulator, '/wc/v3/products/400', { method: 'DELETE' })).status, 404)
  assert.equal((await request(emulator, '/wc/v3/products/batch', { method: 'POST', body: { update: [] } })).status, 404)
})

test('product batch applies updates and rejects create and delete per item', async () => {
  const { emulator, calls } = setup()
  const response = await request(emulator, '/wc/v3/products/batch', {
    method: 'POST',
    body: { create: [{ name: 'New' }], update: [{ id: 400, stock_quantity: 7 }, { id: 999, stock_quantity: 1 }], delete: [300] },
  })
  const result = await response.json()
  assert.equal(result.create[0].error.code, 'rest_no_route')
  assert.equal(result.update[0].stock_quantity, 7)
  assert.equal(result.update[1].error.code, 'woocommerce_rest_product_invalid_id')
  assert.equal(result.delete[0].id, 300)
  assert.equal(result.delete[0].error.code, 'rest_no_route')
  assert.equal(calls.updates.length, 1)
})

test('variations list, read, update, and batch', async () => {
  const { emulator, calls } = setup()
  const list = await request(emulator, '/wc/v3/products/300/variations')
  assert.equal(list.headers.get('x-wp-total'), '2')
  const [m, l] = await list.json()
  assert.equal(m.sku, 'TEE-M')
  assert.equal(m.weight, '0.5')
  assert.deepEqual(m.attributes, [{ id: 1, name: 'Size', option: 'M' }])
  assert.equal(m._links.up[0].href, `${origin}/wp-json/wc/v3/products/300`)
  assert.equal(l.stock_status, 'onbackorder')
  assert.equal(l.image.src, 'https://cdn.example/tee-l.jpg')

  assert.equal((await request(emulator, '/wc/v3/products/300/variations/302')).status, 200)
  assert.equal((await request(emulator, '/wc/v3/products/300/variations/999')).status, 404)
  assert.equal((await request(emulator, '/wc/v3/products/400/variations/301')).status, 404)

  const updated = await request(emulator, '/wc/v3/products/300/variations/302', { method: 'PUT', body: { stock_quantity: 9 } })
  assert.equal((await updated.json()).stock_status, 'instock')
  const batch = await (await request(emulator, '/wc/v3/products/300/variations/batch', {
    method: 'POST', body: { update: [{ id: 301, regular_price: '21.00' }] },
  })).json()
  assert.equal(batch.update[0].regular_price, '21.00')
  assert.deepEqual(calls.updates.map((call) => call.variation), ['var_l', 'var_m'])
})

test('categories, tags, attributes, and terms', async () => {
  const { emulator } = setup()
  const categories = await request(emulator, '/wc/v3/products/categories')
  assert.equal(categories.headers.get('x-wp-total'), '3')
  assert.deepEqual((await categories.json()).map((row) => row.name), ['Apparel', 'Hats', 'Kitchen'])
  const children = await (await request(emulator, '/wc/v3/products/categories', { query: 'parent=5' })).json()
  assert.deepEqual(children.map((row) => row.slug), ['hats'])
  const nonEmpty = await (await request(emulator, '/wc/v3/products/categories', { query: 'hide_empty=true&search=kit' })).json()
  assert.deepEqual(nonEmpty.map((row) => row.slug), ['kitchen'])
  assert.equal((await (await request(emulator, '/wc/v3/products/categories/6')).json()).display, 'default')
  assert.equal((await request(emulator, '/wc/v3/products/categories/99')).status, 404)
  assert.deepEqual((await (await request(emulator, '/wc/v3/products/tags')).json()).map((row) => row.name), ['Sale'])
  const [size] = await (await request(emulator, '/wc/v3/products/attributes')).json()
  assert.equal(size.slug, 'pa_size')
  const terms = await (await request(emulator, '/wc/v3/products/attributes/1/terms', { query: 'orderby=id&order=asc' })).json()
  assert.deepEqual(terms.map((row) => row.name), ['M', 'L'])
  assert.equal((await request(emulator, '/wc/v3/products/attributes/2/terms')).status, 404)
})

test('product.updated webhooks carry the serialized product', async () => {
  const outbound = recordingFetch()
  const { emulator, products } = setup({}, { webhooks: { store: memoryWebhookStore(), fetch: outbound.fetch } })
  await request(emulator, '/wc/v3/webhooks', { method: 'POST', body: { topic: 'product.updated', delivery_url: 'https://hooks.example.net/p' } })
  const [delivery] = await emulator.webhooks.dispatch('product.updated', products[1])
  assert.equal(delivery.success, true)
  const body = JSON.parse(outbound.calls.at(-1).body)
  assert.equal(body.id, 400)
  assert.equal(body.sku, 'MUG')
  assert.equal(outbound.calls.at(-1).headers.get('x-wc-webhook-resource'), 'product')
})
