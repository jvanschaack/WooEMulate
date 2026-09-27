# ????? WooEMulate

> **Turn ANY custom, serverless, or headless store into a WooCommerce-compatible REST API facade.** Connect directly to **Pirate Ship**, **ShipStation**, and third-party logistics tools with zero WordPress or PHP required.

[![npm version](https://img.shields.io/npm/v/wooemulate.svg)](https://www.npmjs.com/package/wooemulate)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)

---

### The Problem

If you run a modern e-commerce site built on **Next.js, Astro, Remix, SvelteKit, MedusaJS, Supabase, Prisma, or Cloudflare Workers/D1**, getting cheap shipping labels is frustrating:
- **Pirate Ship has no public order import API.** They only connect to pre-built integrations like Shopify and WooCommerce.
- Other logistics tools charge steep monthly subscriptions or partner enterprise fees for direct API access.
- WooCommerce integrations, however, are **free and supported by virtually every shipping, inventory, and accounting platform in the world**.

### The Solution

**WooEMulate** is a lightweight, zero-runtime-dependency TypeScript library. It implements the standard **WooCommerce REST API v3** specification and the **WooCommerce 1-Click Connect Handshake**.

To Pirate Ship, ShipStation, or any shipping software, your custom site looks, talks, and behaves exactly like a real WooCommerce store!

---

### Features

- ? **Zero WordPress / Zero PHP:** Pure TypeScript. Runs natively on Cloudflare Workers, Next.js (Edge or Node), Astro, Remix, Bun, Deno, Fastify, and Express.
- ?? **Pirate Ship 1-Click Connect:** Supports the `/wc-auth/v1/authorize` instant credential handshake.
- ?? **Automated Parcel Sizing:** Calculates package weights and bounding dimensions from line items so shipping labels are pre-filled accurately in Pirate Ship.
- ?? **Shipment Tracking Extension:** Implements the official *WooCommerce Shipment Tracking* endpoint—printed labels instantly update tracking numbers in your custom database.
- ?? **Numeric ID Bridge:** Deterministically translates arbitrary string IDs (e.g. `ord_12345` or `INV-9852`) into 31-bit integers required by strict WooCommerce clients.
- ??? **Dual Authentication:** Supports both HTTP Basic Auth headers (`Authorization: Basic ...`) and query parameter credentials (`consumer_key` / `consumer_secret`).

---

### Installation

```bash
npm install wooemulate
```

---

### Quickstart

#### 1. Define Your Emulator & Database Adapter

```typescript
import { createWooEmulate } from 'wooemulate'

export const emulator = createWooEmulate({
  store: {
    name: 'My Awesome Store',
    url: 'https://myawesomestore.com',
    currency: 'USD', // Default 'USD'
  },
  auth: {
    consumerKey: process.env.WC_CONSUMER_KEY!,
    consumerSecret: process.env.WC_CONSUMER_SECRET!,
  },
  adapter: {
    // 1. Return unfulfilled orders for Pirate Ship to import
    async listOrders({ status, page, perPage }) {
      const dbOrders = await myDb.orders.findMany({
        where: { status: status === 'processing' ? 'paid' : undefined },
        take: perPage,
        skip: (page - 1) * perPage,
      })

      return {
        orders: dbOrders.map(toWooEmulateFormat),
        totalCount: await myDb.orders.count(),
      }
    },

    // 2. Fetch a single order by ID or order number
    async getOrder(idOrNumber) {
      const order = await myDb.orders.findFirst({
        where: { OR: [{ id: idOrNumber }, { orderNumber: idOrNumber }] },
      })
      return order ? toWooEmulateFormat(order) : null
    },

    // 3. Automatically called when Pirate Ship prints a shipping label!
    async onShipmentTrackingCreated(orderId, { trackingNumber, carrier, dateShipped }) {
      await myDb.fulfillments.create({
        data: {
          orderId,
          trackingNumber,
          carrier,
          shippedAt: dateShipped || new Date(),
        },
      })
      await myDb.orders.update({
        where: { id: orderId },
        data: { status: 'shipped' },
      })
      return { id: 1 }
    },

    // 4. (Optional) Called when status is changed
    async updateOrderStatus(orderId, status) {
      await myDb.orders.update({ where: { id: orderId }, data: { status } })
    },
  },
})
```

---

### Mounting in Web Frameworks

WooEMulate is built using the standard Fetch API `Request` and `Response`, making integration effortless.

#### Next.js (App Router)
Create `app/wp-json/[...slug]/route.ts` and `app/wc-auth/[...slug]/route.ts`:

```typescript
import { emulator } from '@/lib/wooemulate'

export const GET = (req: Request) => emulator.handleRequest(req)
export const POST = (req: Request) => emulator.handleRequest(req)
export const PUT = (req: Request) => emulator.handleRequest(req)
export const OPTIONS = (req: Request) => emulator.handleRequest(req)
```

#### Astro
Create `src/pages/[...wp_json].ts`:

```typescript
import type { APIRoute } from 'astro'
import { emulator } from '@/lib/wooemulate'

export const prerender = false
export const ALL: APIRoute = ({ request }) => emulator.handleRequest(request)
```

#### Cloudflare Workers
```typescript
import { emulator } from './wooemulate'

export default {
  async fetch(request: Request) {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/wp-json') || url.pathname.startsWith('/wc-auth')) {
      return emulator.handleRequest(request)
    }
    return new Response('Not Found', { status: 404 })
  },
}
```

---

### Connecting to Pirate Ship

1. Log into **Pirate Ship** &rarr; **Settings** &rarr; **Integrations**.
2. Click **WooCommerce**.
3. Enter your store URL (e.g., `https://myawesomestore.com`).
4. Enter your `consumerKey` and `consumerSecret` (or use the 1-click connect button).
5. Click **Connect**. Pirate Ship tests the `/wp-json` endpoint and system status.
6. Click **Import Orders**—all your unfulfilled store orders will appear instantly, pre-filled with customer addresses, package weights, and dimensions!
7. When you buy a label, Pirate Ship writes the tracking number directly back to your database via `/shipment-trackings`.

---

### Order Data Schema

When returning orders from `listOrders` or `getOrder`, format them using the `WooEmulateOrder` interface:

```typescript
interface WooEmulateOrder {
  id: string | number
  orderNumber: string
  status: 'pending' | 'processing' | 'on-hold' | 'completed' | 'cancelled' | 'refunded'
  createdAt: string | Date
  totalCents: number
  shippingCents?: number
  taxCents?: number
  discountCents?: number
  customer?: {
    name?: string
    email?: string
    phone?: string
  }
  shippingAddress: {
    firstName: string
    lastName?: string
    company?: string
    address1: string
    address2?: string
    city: string
    state: string
    postalCode: string
    country?: string // Default 'US'
  }
  items: Array<{
    id?: string | number
    name: string
    sku?: string
    quantity: number
    unitPriceCents: number
    weightLb?: number
    dimensionsIn?: {
      length?: number
      width?: number
      height?: number
    }
  }>
}
```

---

### Security & Privacy

WooEMulate does not collect analytics or store data. It acts purely as a stateless protocol translator between incoming HTTP requests and your database adapter.

---

### License

MIT License © 2026 WooEMulate Contributors
