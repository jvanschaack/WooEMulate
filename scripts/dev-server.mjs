// Local WooEMulate server with sample data for third-party client checks.
// Usage: npm run build && node scripts/dev-server.mjs [port=8787] [orders=250]
// Credentials: ck_fixture / cs_fixture. Webhook delivery URLs are not restricted, so local
// tools (for example n8n on http://127.0.0.1:5678) can receive them. GET /__dispatch sends an
// order.updated webhook for the first order. Requests are logged to stderr. For local use only.
import http from 'node:http'
import { createWooEmulate } from '../dist/index.js'
import { auth, makeOrder, memoryAdapter, memoryCatalog, memoryWebhookStore } from '../tests/helpers.mjs'

const port = Number(process.argv[2] || 8787)
const count = Number(process.argv[3] || 250)
const orders = Array.from({ length: count }, (_, i) => makeOrder(i + 1))
const { adapter } = memoryAdapter(orders)
adapter.products = memoryCatalog().catalog
const store = memoryWebhookStore()
const emulator = createWooEmulate({
  store: { name: 'Harness', url: `http://127.0.0.1:${port}` },
  auth,
  adapter,
  webhooks: { store, validateDeliveryUrl: () => true },
  onRequest: (event) => console.error(JSON.stringify(event)),
})
http.createServer(async (req, res) => {
  if (req.url === '/__dispatch') {
    const results = await emulator.webhooks.dispatch('order.updated', orders[0])
    res.end(JSON.stringify(results))
    return
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const response = await emulator.handleRequest(new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method, headers: req.headers,
    ...(chunks.length && !['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}),
  }))
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(Buffer.from(await response.arrayBuffer()))
}).listen(port, '127.0.0.1', () => console.error(`listening ${port}`))
