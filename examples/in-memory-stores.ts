/**
 * Demo stores only. They keep state in memory, which is lost on restart and not shared between
 * serverless instances. Back each one with your database before using webhooks, multiple API
 * keys, or OAuth 1.0a in production.
 */
import type {
  WooEmulateApiKey,
  WooEmulateApiKeyStore,
  WooEmulateOAuth1Config,
  WooEmulateWebhook,
  WooEmulateWebhookStore,
} from 'wooemulate'

const webhooks = new Map<number, WooEmulateWebhook>()
let nextWebhookId = 1

export const demoWebhookStore: WooEmulateWebhookStore = {
  async listWebhooks() {
    return [...webhooks.values()]
  },
  async getWebhook(id) {
    return webhooks.get(id) ?? null
  },
  async createWebhook(input) {
    const webhook = { ...input, id: nextWebhookId++, createdAt: new Date().toISOString() }
    webhooks.set(webhook.id, webhook)
    return webhook
  },
  async updateWebhook(id, changes) {
    const existing = webhooks.get(id)
    if (!existing) throw new Error('Webhook not found')
    const webhook = { ...existing, ...changes, updatedAt: new Date().toISOString() }
    webhooks.set(id, webhook)
    return webhook
  },
  async deleteWebhook(id) {
    webhooks.delete(id)
  },
}

// Keys minted by one-click authorization land here. Store secrets encrypted in production.
const keys = new Map<string, WooEmulateApiKey>()
let nextKeyId = 2

export const demoApiKeyStore: WooEmulateApiKeyStore = {
  async findApiKey(consumerKey) {
    return keys.get(consumerKey) ?? null
  },
  async createApiKey({ consumerKey, consumerSecret, permissions, description, userId }) {
    const keyId = nextKeyId++
    keys.set(consumerKey, { keyId, consumerKey, consumerSecret, permissions, description, userId })
    return { keyId }
  },
  async deleteApiKey(keyId) {
    for (const [consumerKey, key] of keys) if (key.keyId === keyId) keys.delete(consumerKey)
  },
}

// Nonces only need to be remembered for WooCommerce's 15-minute timestamp window.
const nonces = new Map<string, number>()

export const demoOAuth1: WooEmulateOAuth1Config = {
  async useNonce(consumerKey, nonce, timestamp) {
    const cutoff = Date.now() / 1000 - 15 * 60
    for (const [id, seen] of nonces) if (seen < cutoff) nonces.delete(id)
    const id = `${consumerKey}:${nonce}`
    if (nonces.has(id)) return false
    nonces.set(id, timestamp)
    return true
  },
}
