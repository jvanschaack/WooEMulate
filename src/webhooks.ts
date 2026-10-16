/**
 * WooEMulate Webhooks
 * Topic validation, delivery URL policy, and signed delivery compatible with WooCommerce
 * webhooks (`X-WC-Webhook-*` headers, base64 HMAC-SHA256 signature of the raw body).
 */

import { getWcNumericId } from './helpers.js'
import { serializeWcOrder } from './serializer.js'
import { serializeWcCoupon, serializeWcCustomer } from './serializers/customers.js'
import { serializeWcProduct } from './serializers/products.js'
import type {
  WooEmulateConfig,
  WooEmulateCoupon,
  WooEmulateCustomer,
  WooEmulateOrder,
  WooEmulateProduct,
  WooEmulateWebhook,
  WooEmulateWebhookApiVersion,
  WooEmulateWebhookDelivery,
} from './types.js'

/** WooCommerce's documented webhook topics and the hooks that fire them. */
export const TOPIC_HOOKS: Record<string, string[]> = {
  'coupon.created': ['woocommerce_process_shop_coupon_meta', 'woocommerce_new_coupon'],
  'coupon.updated': ['woocommerce_process_shop_coupon_meta', 'woocommerce_update_coupon'],
  'coupon.deleted': ['wp_trash_post'],
  'coupon.restored': ['untrashed_post'],
  'customer.created': ['user_register', 'woocommerce_created_customer', 'woocommerce_new_customer'],
  'customer.updated': ['profile_update', 'woocommerce_update_customer'],
  'customer.deleted': ['delete_user'],
  'order.created': ['woocommerce_new_order'],
  'order.updated': ['woocommerce_update_order', 'woocommerce_order_refunded'],
  'order.deleted': ['wp_trash_post', 'woocommerce_trash_order'],
  'order.restored': ['untrashed_post', 'woocommerce_untrash_order'],
  'product.created': ['woocommerce_process_product_meta', 'woocommerce_new_product', 'woocommerce_new_product_variation'],
  'product.updated': ['woocommerce_process_product_meta', 'woocommerce_update_product', 'woocommerce_update_product_variation'],
  'product.deleted': ['wp_trash_post'],
  'product.restored': ['untrashed_post'],
}

/** Valid topics are the documented ones plus `action.woocommerce_*` and `action.wc_*`. */
export function isValidWebhookTopic(topic: unknown): topic is string {
  if (typeof topic !== 'string') return false
  if (/^action\.(woocommerce_|wc_)[\w-]+$/.test(topic)) return true
  return topic in TOPIC_HOOKS
}

export function splitTopic(topic: string): { resource: string; event: string } {
  const index = topic.indexOf('.')
  return { resource: topic.slice(0, index), event: topic.slice(index + 1) }
}

export function topicHooks(topic: string): string[] {
  if (topic.startsWith('action.')) return [topic.slice('action.'.length)]
  return TOPIC_HOOKS[topic] ?? []
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  )
}

/** Expands an IPv6 literal into eight 16-bit groups, or returns null when it is not one. */
function parseIpv6(host: string): number[] | null {
  let text = host
  const embedded = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (embedded) {
    const octets = embedded[2].split('.').map(Number)
    if (octets.some((octet) => octet > 255)) return null
    text = `${embedded[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null
  return groups.map((group) => parseInt(group, 16))
}

function ipv4FromGroups(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
}

/** Blocks IPv6 addresses that are local or that embed an IPv4 address WooEMulate cannot vet. */
function isBlockedIpv6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups
  if (groups.slice(0, 6).every((group) => group === 0)) return true // ::, ::1, IPv4-compatible ::/96
  if (groups.slice(0, 5).every((group) => group === 0) && g5 === 0xffff) return true // IPv4-mapped
  if ((g0 & 0xfe00) === 0xfc00) return true // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true // link-local, site-local
  if ((g0 & 0xff00) === 0xff00) return true // multicast
  if (g0 === 0x64 && g1 === 0xff9b) {
    // NAT64: 64:ff9b::/96 embeds an IPv4 address; 64:ff9b:1::/48 is for local use.
    return g2 !== 0 || g3 !== 0 || g4 !== 0 || g5 !== 0 || isPrivateIpv4(ipv4FromGroups(g6, g7))
  }
  if (g0 === 0x2002) return isPrivateIpv4(ipv4FromGroups(g1, g2)) // 6to4 embeds an IPv4 address
  if (g0 === 0x2001 && g1 === 0) return true // Teredo
  return false
}

/**
 * Default delivery URL policy: HTTPS, no credentials, and no localhost, single-label,
 * private, loopback, link-local, or other internal hosts. Hostnames that resolve to private
 * addresses cannot be detected here; use `validateDeliveryUrl` for stricter rules.
 */
export function isSafeDeliveryUrl(url: URL): boolean {
  if (url.protocol !== 'https:' || url.username || url.password) return false
  // A trailing dot makes a name fully qualified ("localhost.") without changing where it points.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  if (!host) return false
  if (host.includes(':')) {
    const groups = parseIpv6(host)
    return groups !== null && !isBlockedIpv6(groups)
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return !isPrivateIpv4(host)
  if (!host.includes('.')) return false
  return !/(^|\.)(localhost|local|internal|home\.arpa|localdomain|cluster\.local)$/.test(host)
}

export async function deliveryUrlAllowed(config: WooEmulateConfig, value: string): Promise<boolean> {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const validate = config.webhooks?.validateDeliveryUrl
  try {
    return validate ? (await validate(url)) === true : isSafeDeliveryUrl(url)
  } catch {
    return false
  }
}

export function generateSecret(length = 50): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_[]{}<>~+=,.;:/?|'
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
}

function randomHex(bytes = 16): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Computes `X-WC-Webhook-Signature`: base64 HMAC-SHA256 of the raw payload. */
export async function signWebhookPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)))
  let binary = ''
  for (const byte of signature) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function apiVersionFromNamespace(namespace: string): WooEmulateWebhookApiVersion {
  if (namespace === 'wc/v1') return 'wp_api_v1'
  if (namespace === 'wc/v2') return 'wp_api_v2'
  return 'wp_api_v3'
}

function namespaceOf(apiVersion: WooEmulateWebhookApiVersion): 'v1' | 'v2' | 'v3' {
  return apiVersion === 'wp_api_v1' ? 'v1' : apiVersion === 'wp_api_v2' ? 'v2' : 'v3'
}

/** Public API root used in payload links and `X-WC-Webhook-Source`. */
export function storeHome(config: WooEmulateConfig): string {
  return new URL(config.store.url).origin + (config.basePath || '')
}

export type ResourceSerializer = (
  resource: unknown,
  config: WooEmulateConfig,
  version: 'v1' | 'v2' | 'v3',
  apiBase: string
) => Record<string, any>

/** Serializers for webhook payloads, keyed by resource. Extended as resources are added. */
export const RESOURCE_SERIALIZERS: Record<string, ResourceSerializer> = {
  order: (resource, config, version, apiBase) =>
    serializeWcOrder(resource as WooEmulateOrder, config.store, { version, apiBase }),
  product: (resource, config, version, apiBase) =>
    serializeWcProduct(resource as WooEmulateProduct, config.store, { version, apiBase }),
  customer: (resource, config, version, apiBase) =>
    serializeWcCustomer(resource as WooEmulateCustomer, config.store, { version, apiBase }),
  coupon: (resource, config, version, apiBase) =>
    serializeWcCoupon(resource as WooEmulateCoupon, config.store, { version, apiBase }),
}

function resourceApiId(resource: unknown): number {
  if (typeof resource === 'number') return getWcNumericId(resource)
  if (resource && typeof resource === 'object') {
    const record = resource as { wooCommerceId?: number; id?: string | number }
    return getWcNumericId(record.wooCommerceId ?? (record.id as string | number))
  }
  throw new Error('Webhook resources must be the resource object or its numeric API ID.')
}

function isOrderLike(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && 'orderNumber' in (value as object) && 'items' in (value as object))
}

/** Builds the JSON payload WooCommerce would send for a topic at a given API version. */
export function buildWebhookPayload(
  config: WooEmulateConfig,
  topic: string,
  resource: unknown,
  apiVersion: WooEmulateWebhookApiVersion
): Record<string, any> {
  const { resource: kind, event } = splitTopic(topic)
  if (kind === 'action') {
    return { action: event, arg: isOrderLike(resource) ? resourceApiId(resource) : resource }
  }
  if (event === 'deleted') return { id: resourceApiId(resource) }
  const serializer = RESOURCE_SERIALIZERS[kind]
  if (!serializer) throw new Error(`Webhook payloads for ${kind} resources are not supported.`)
  if (!resource || typeof resource !== 'object') {
    throw new Error(`Pass the ${kind} object to dispatch ${topic}.`)
  }
  const version = namespaceOf(apiVersion)
  return serializer(resource, config, version, `${storeHome(config)}/wp-json/wc/${version}`)
}

function userAgent(config: WooEmulateConfig): string {
  return `WooCommerce/${config.store.version || '8.5.0'} Hookshot (WordPress/6.4.3)`
}

/** Sends WooCommerce's unsigned `webhook_id=<id>` ping. The result is ignored, as in WooCommerce. */
export async function pingWebhook(config: WooEmulateConfig, webhook: WooEmulateWebhook): Promise<void> {
  if (!(await deliveryUrlAllowed(config, webhook.deliveryUrl))) return
  const send = config.webhooks?.fetch ?? fetch
  try {
    await send(webhook.deliveryUrl, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgent(config) },
      body: `webhook_id=${webhook.id}`,
    })
  } catch {
    // Ping failures do not affect webhook creation.
  }
}

async function deliver(
  config: WooEmulateConfig,
  webhook: WooEmulateWebhook,
  topic: string,
  body: string
): Promise<WooEmulateWebhookDelivery> {
  const settings = config.webhooks!
  const started = Date.now()
  const deliveryId = randomHex()
  const { resource, event } = splitTopic(topic)
  let status: number | null = null
  let error: string | undefined

  if (!(await deliveryUrlAllowed(config, webhook.deliveryUrl))) {
    error = 'Delivery URL is not allowed.'
  } else {
    try {
      const response = await (settings.fetch ?? fetch)(webhook.deliveryUrl, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(settings.timeoutMs ?? 30_000),
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': userAgent(config),
          'X-WC-Webhook-Source': `${storeHome(config)}/`,
          'X-WC-Webhook-Topic': topic,
          'X-WC-Webhook-Resource': resource,
          'X-WC-Webhook-Event': event,
          'X-WC-Webhook-Signature': await signWebhookPayload(body, webhook.secret),
          'X-WC-Webhook-ID': String(webhook.id),
          'X-WC-Webhook-Delivery-ID': deliveryId,
        },
        body,
      })
      status = response.status
      await response.body?.cancel().catch(() => undefined)
    } catch (err) {
      error = err instanceof Error ? err.name || err.message : 'Delivery failed.'
    }
  }

  // WooCommerce treats 200-302 as success; other results count toward auto-disabling.
  const success = status !== null && status >= 200 && status <= 302
  try {
    if (success && webhook.failureCount > 0) {
      await settings.store.updateWebhook(webhook.id, { failureCount: 0 })
    } else if (!success) {
      const max = settings.maxDeliveryFailures ?? 5
      await settings.store.updateWebhook(
        webhook.id,
        webhook.failureCount > max ? { status: 'disabled' } : { failureCount: webhook.failureCount + 1 }
      )
    }
  } catch {
    // Failure bookkeeping must not hide the delivery result.
  }

  const result: WooEmulateWebhookDelivery = {
    webhookId: webhook.id,
    deliveryId,
    topic,
    status,
    success,
    ...(error ? { error } : {}),
    durationMs: Date.now() - started,
  }
  try {
    await settings.onDelivery?.(result)
  } catch {
    // Observers never affect delivery.
  }
  return result
}

/**
 * Delivers a topic to every active webhook subscribed to it. Pass the current resource object
 * (an order, product, customer, or coupon) for created/updated/restored/deleted topics, and the
 * hook argument for `action.*` topics.
 */
export async function dispatchWebhooks(
  config: WooEmulateConfig,
  topic: string,
  resource: unknown
): Promise<WooEmulateWebhookDelivery[]> {
  if (!config.webhooks) return []
  if (!isValidWebhookTopic(topic)) throw new Error(`Invalid webhook topic: ${topic}`)
  const targets = (await config.webhooks.store.listWebhooks()).filter(
    (webhook) => webhook.status === 'active' && webhook.topic === topic
  )
  const bodies = new Map<WooEmulateWebhookApiVersion, string>()
  return Promise.all(
    targets.map((webhook) => {
      const apiVersion = webhook.apiVersion || 'wp_api_v3'
      if (!bodies.has(apiVersion)) {
        bodies.set(apiVersion, JSON.stringify(buildWebhookPayload(config, topic, resource, apiVersion)))
      }
      return deliver(config, webhook, topic, bodies.get(apiVersion)!)
    })
  )
}
