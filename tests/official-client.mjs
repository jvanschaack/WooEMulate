// Conformance against WooCommerce's official JavaScript client (@woocommerce/woocommerce-rest-api)
// over real HTTP and HTTPS servers. Over HTTP the client signs requests with OAuth 1.0a; over HTTPS
// it uses Basic auth or query-string credentials.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WooCommerceRestApiPkg from '@woocommerce/woocommerce-rest-api'
import { createWooEmulate } from '../dist/index.js'
import { auth, makeOrder, memoryAdapter, memoryCatalog } from './helpers.mjs'

const WooCommerceRestApi = WooCommerceRestApiPkg.default ?? WooCommerceRestApiPkg

/** Bridges Node's HTTP server to the Fetch-based emulator. */
function bridge(emulator) {
  return async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const protocol = req.socket.encrypted ? 'https' : 'http'
    const request = new Request(`${protocol}://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers,
      ...(chunks.length && req.method !== 'GET' && req.method !== 'HEAD' ? { body: Buffer.concat(chunks) } : {}),
    })
    const response = await emulator.handleRequest(request)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function makeEmulator(url) {
  const orders = Array.from({ length: 23 }, (_, i) => makeOrder(i + 1))
  const { adapter } = memoryAdapter(orders)
  adapter.products = memoryCatalog().catalog
  const nonces = new Set()
  const emulator = createWooEmulate({
    store: { name: 'Example', url },
    auth,
    adapter,
    oauth1: { useNonce: async (key, nonce) => (nonces.has(nonce) ? false : (nonces.add(nonce), true)) },
  })
  return { emulator, orders }
}

async function exercise(api, orders) {
  const list = await api.get('orders', { per_page: 10, page: 2, status: 'processing', orderby: 'id', order: 'asc' })
  assert.equal(list.status, 200)
  assert.equal(list.headers['x-wp-total'], '23')
  assert.equal(list.headers['x-wp-totalpages'], '3')
  assert.deepEqual(list.data.map((order) => order.id), [1011, 1012, 1013, 1014, 1015, 1016, 1017, 1018, 1019, 1020])
  assert.match(list.headers.link, /rel="next"/)

  const single = await api.get('orders/1005')
  assert.equal(single.data.number, 'STORE-5')

  const updated = await api.put('orders/1005', { status: 'completed' })
  assert.equal(updated.data.status, 'completed')
  assert.equal(orders[4].status, 'completed')

  const tracking = await api.post('orders/1006/shipment-trackings', { tracking_number: '1Z999AA10123456784', tracking_provider: 'UPS' })
  assert.equal(tracking.status, 201)

  const product = await api.put('products/400', { stock_quantity: 3 })
  assert.equal(product.data.stock_quantity, 3)

  const missing = await api.get('orders/9999').catch((err) => err.response)
  assert.equal(missing.status, 404)
  assert.equal(missing.data.code, 'woocommerce_rest_shop_order_invalid_id')
}

test('official client over HTTP authenticates with OAuth 1.0a signatures', async () => {
  const server = http.createServer()
  const port = await listen(server)
  const url = `http://127.0.0.1:${port}`
  const { emulator, orders } = makeEmulator(url)
  server.on('request', bridge(emulator))
  try {
    const api = new WooCommerceRestApi({ url, consumerKey: auth.consumerKey, consumerSecret: auth.consumerSecret, version: 'wc/v3' })
    await exercise(api, orders)
    const wrong = new WooCommerceRestApi({ url, consumerKey: auth.consumerKey, consumerSecret: 'cs_wrong', version: 'wc/v3' })
    const denied = await wrong.get('orders').catch((err) => err.response)
    assert.equal(denied.status, 401)
    assert.equal(denied.data.message, 'Invalid signature - provided signature does not match.')
  } finally {
    server.close()
  }
})

function selfSignedCert() {
  const dir = mkdtempSync(join(tmpdir(), 'wooemulate-tls-'))
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
    ], { stdio: 'ignore' })
    return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

let tls
try {
  tls = selfSignedCert()
} catch {
  tls = null
}

for (const queryStringAuth of [false, true]) {
  test(`official client over HTTPS with ${queryStringAuth ? 'query-string' : 'Basic'} credentials`, { skip: !tls && 'openssl unavailable' }, async () => {
    const server = https.createServer({ key: tls.key, cert: tls.cert })
    const port = await listen(server)
    const url = `https://localhost:${port}`
    const { emulator, orders } = makeEmulator(url)
    server.on('request', bridge(emulator))
    try {
      // Trust only the throwaway certificate generated above; verification stays enabled.
      const httpsAgent = new https.Agent({ ca: tls.cert })
      const api = new WooCommerceRestApi({
        url, consumerKey: auth.consumerKey, consumerSecret: auth.consumerSecret, version: 'wc/v3',
        queryStringAuth, axiosConfig: { httpsAgent, proxy: false },
      })
      await exercise(api, orders)
    } finally {
      server.close()
    }
  })
}
