/**
 * WooEMulate Webhooks Handler
 * Implements the `/webhooks` CRUD and batch API backed by the configured webhook store.
 */

import { wcErrorResponse } from '../auth.js'
import { wcDatePair, toDate } from '../dates.js'
import {
  ParamErrors,
  errorMessage,
  handleBatch,
  jsonResponse,
  paginateInMemory,
  paginationHeaders,
  parseBoolean,
  parseEnum,
  parseListParams,
  routeUrl,
  type RouteContext,
} from '../http.js'
import type { WooEmulateWebhook, WooEmulateWebhookInput } from '../types.js'
import {
  apiVersionFromNamespace,
  deliveryUrlAllowed,
  generateSecret,
  isValidWebhookTopic,
  pingWebhook,
  splitTopic,
  topicHooks,
} from '../webhooks.js'

const STATUSES = ['active', 'paused', 'disabled'] as const

function invalidId(): Response {
  return wcErrorResponse('woocommerce_rest_shop_webhook_invalid_id', 'Invalid ID.', 404)
}

export function serializeWebhook(ctx: RouteContext, webhook: WooEmulateWebhook): Record<string, any> {
  const timeZone = ctx.config.store.timezone || 'UTC'
  const created = wcDatePair(webhook.createdAt, timeZone)
  const modified = webhook.updatedAt ? wcDatePair(webhook.updatedAt, timeZone) : created
  const { resource, event } = splitTopic(webhook.topic)
  return {
    id: webhook.id,
    name: webhook.name,
    status: webhook.status,
    topic: webhook.topic,
    resource,
    event,
    hooks: topicHooks(webhook.topic),
    delivery_url: webhook.deliveryUrl,
    date_created: created.local,
    date_created_gmt: created.gmt,
    date_modified: modified.local,
    date_modified_gmt: modified.gmt,
    _links: {
      self: [{ href: routeUrl(ctx, `/webhooks/${webhook.id}`) }],
      collection: [{ href: routeUrl(ctx, '/webhooks') }],
    },
  }
}

function store(ctx: RouteContext) {
  return ctx.config.webhooks!.store
}

async function findWebhook(ctx: RouteContext): Promise<WooEmulateWebhook | null> {
  const id = Number(ctx.params.id)
  if (!Number.isSafeInteger(id)) return null
  const webhook = await store(ctx).getWebhook(id)
  return webhook && webhook.id === id ? webhook : null
}

function schedule(ctx: RouteContext, work: Promise<unknown>): Promise<unknown> | undefined {
  if (ctx.waitUntil) {
    ctx.waitUntil(work)
    return undefined
  }
  return work
}

/** Validates writable fields. Returns the changes or an error response. */
async function readChanges(
  ctx: RouteContext,
  input: Record<string, any>,
  creating: boolean
): Promise<Partial<WooEmulateWebhookInput> | Response> {
  const errors = new ParamErrors()
  const changes: Partial<WooEmulateWebhookInput> = {}
  if (input.name !== undefined) changes.name = String(input.name)
  if (input.status !== undefined) {
    const status = parseEnum(errors, 'status', input.status, STATUSES)
    if (status) changes.status = status
  }
  if (input.secret !== undefined && input.secret !== '') changes.secret = String(input.secret)
  if (errors.any) return errors.response()

  if (creating || input.topic !== undefined) {
    if (!isValidWebhookTopic(input.topic)) {
      return wcErrorResponse('woocommerce_rest_webhook_invalid_topic', 'Webhook topic is required and must be valid.', 400)
    }
    changes.topic = input.topic
  }
  if (creating || input.delivery_url !== undefined) {
    const url = typeof input.delivery_url === 'string' ? input.delivery_url.trim() : ''
    if (!/^https?:\/\//i.test(url)) {
      return wcErrorResponse(
        'woocommerce_rest_webhook_invalid_delivery_url',
        'Webhook delivery URL must be a valid URL starting with http:// or https://.',
        400
      )
    }
    if (!(await deliveryUrlAllowed(ctx.config, url))) {
      return wcErrorResponse('woocommerce_rest_webhook_invalid_delivery_url', 'Webhook delivery URL is not allowed.', 400)
    }
    changes.deliveryUrl = url
  }
  return changes
}

export async function listWebhooks(ctx: RouteContext): Promise<Response> {
  const errors = new ParamErrors()
  const params = parseListParams(ctx, errors, { orderby: ['date', 'id', 'title'] as const, defaultOrderby: 'date', dates: true })
  const status = parseEnum(errors, 'status', ctx.url.searchParams.get('status'), ['all', ...STATUSES] as const) ?? 'all'
  if (errors.any) return errors.response()
  try {
    const time = (webhook: WooEmulateWebhook) => toDate(webhook.createdAt)?.getTime() ?? 0
    let rows = await store(ctx).listWebhooks()
    if (status !== 'all') rows = rows.filter((webhook) => webhook.status === status)
    if (params.after) rows = rows.filter((webhook) => time(webhook) > Date.parse(params.after!))
    if (params.before) rows = rows.filter((webhook) => time(webhook) < Date.parse(params.before!))
    const page = paginateInMemory(rows, params, {
      id: (webhook) => webhook.id,
      search: (webhook) => [webhook.name, webhook.topic, webhook.deliveryUrl],
      sort: (webhook, orderby) => (orderby === 'title' ? webhook.name : time(webhook)),
    })
    return jsonResponse(
      page.items.map((webhook) => serializeWebhook(ctx, webhook)),
      200,
      paginationHeaders(ctx, { page: params.page, perPage: params.perPage, total: page.total })
    )
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_webhooks_error', errorMessage(err, 'Failed to list webhooks.'), 500)
  }
}

export async function getWebhook(ctx: RouteContext): Promise<Response> {
  const webhook = await findWebhook(ctx)
  return webhook ? jsonResponse(serializeWebhook(ctx, webhook)) : invalidId()
}

export async function createWebhook(ctx: RouteContext): Promise<Response> {
  const input = await ctx.input()
  const changes = await readChanges(ctx, input, true)
  if (changes instanceof Response) return changes
  try {
    const webhook = await store(ctx).createWebhook({
      name: changes.name || `Webhook created on ${new Date().toUTCString()}`,
      status: changes.status ?? 'active',
      topic: changes.topic!,
      deliveryUrl: changes.deliveryUrl!,
      secret: changes.secret ?? generateSecret(),
      apiVersion: apiVersionFromNamespace(ctx.namespace),
      failureCount: 0,
    })
    if (webhook.status === 'active') await schedule(ctx, pingWebhook(ctx.config, webhook))
    return jsonResponse(serializeWebhook(ctx, webhook), 201, { Location: routeUrl(ctx, `/webhooks/${webhook.id}`) })
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_webhook_create_error', errorMessage(err, 'Failed to create webhook.'), 500)
  }
}

export async function updateWebhook(ctx: RouteContext): Promise<Response> {
  const existing = await findWebhook(ctx)
  if (!existing) return invalidId()
  const changes = await readChanges(ctx, await ctx.input(), false)
  if (changes instanceof Response) return changes
  // Reactivating a webhook clears its failure count.
  const activating = changes.status === 'active' && existing.status !== 'active'
  if (activating) changes.failureCount = 0
  try {
    const webhook = await store(ctx).updateWebhook(existing.id, changes)
    if (activating) await schedule(ctx, pingWebhook(ctx.config, webhook))
    return jsonResponse(serializeWebhook(ctx, webhook))
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_webhook_update_error', errorMessage(err, 'Failed to update webhook.'), 500)
  }
}

export async function deleteWebhook(ctx: RouteContext): Promise<Response> {
  const errors = new ParamErrors()
  const force = parseBoolean(errors, 'force', (await ctx.input()).force) ?? false
  if (errors.any) return errors.response()
  if (!force) {
    return wcErrorResponse('woocommerce_rest_trash_not_supported', 'Webhooks do not support trashing.', 501)
  }
  const existing = await findWebhook(ctx)
  if (!existing) return invalidId()
  try {
    await store(ctx).deleteWebhook(existing.id)
    return jsonResponse(serializeWebhook(ctx, existing))
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_cannot_delete', errorMessage(err, 'The webhook cannot be deleted.'), 500)
  }
}

export async function batchWebhooks(ctx: RouteContext): Promise<Response> {
  return handleBatch(ctx, { create: createWebhook, update: updateWebhook, delete: deleteWebhook })
}
