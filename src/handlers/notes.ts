/**
 * WooEMulate Order Notes Handler
 * Implements `/orders/:order_id/notes`, the main way shipping services write tracking back.
 */

import { wcErrorResponse } from '../auth.js'
import { ParamErrors, errorMessage, jsonResponse, parseBoolean, parseEnum, type RouteContext } from '../http.js'
import { findOrderByApiId } from '../order-lookup.js'
import { serializeWcOrderNote } from '../serializer.js'
import { parseTrackingFromNote } from '../tracking-notes.js'
import type { WooEmulateOrder, WooEmulateOrderNote } from '../types.js'

const NOTE_TYPES = ['any', 'customer', 'internal'] as const

async function loadOrder(ctx: RouteContext): Promise<WooEmulateOrder | Response> {
  try {
    const order = await findOrderByApiId(ctx.config, ctx.params.order_id)
    return order ?? wcErrorResponse('woocommerce_rest_order_invalid_id', 'Invalid order ID.', 404)
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_order_error', errorMessage(err, 'Failed to retrieve order.'), 500)
  }
}

function serialize(ctx: RouteContext, note: WooEmulateOrderNote) {
  return serializeWcOrderNote(note, ctx.config.store, {
    version: ctx.version,
    apiBase: `${ctx.apiBase}/${ctx.namespace}`,
    orderId: Number(ctx.params.order_id),
  })
}

async function findNote(ctx: RouteContext, order: WooEmulateOrder): Promise<WooEmulateOrderNote | null> {
  const notes = await ctx.config.adapter.listOrderNotes!(order.id, { type: 'any' })
  return notes.find((note) => String(note.id) === ctx.params.id) ?? null
}

export async function listOrderNotes(ctx: RouteContext): Promise<Response> {
  const errors = new ParamErrors()
  const type = parseEnum(errors, 'type', ctx.url.searchParams.get('type'), NOTE_TYPES) ?? 'any'
  if (errors.any) return errors.response()
  const order = await loadOrder(ctx)
  if (order instanceof Response) return order
  try {
    const notes = (await ctx.config.adapter.listOrderNotes!(order.id, { type })).filter(
      (note) => type === 'any' || (type === 'customer') === Boolean(note.customerNote)
    )
    return jsonResponse(notes.map((note) => serialize(ctx, note)))
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_order_notes_error', errorMessage(err, 'Failed to list notes.'), 500)
  }
}

export async function getOrderNote(ctx: RouteContext): Promise<Response> {
  const order = await loadOrder(ctx)
  if (order instanceof Response) return order
  try {
    const note = await findNote(ctx, order)
    if (!note) return wcErrorResponse('woocommerce_rest_invalid_id', 'Invalid resource ID.', 404)
    return jsonResponse(serialize(ctx, note))
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_order_notes_error', errorMessage(err, 'Failed to read note.'), 500)
  }
}

export async function createOrderNote(ctx: RouteContext): Promise<Response> {
  const order = await loadOrder(ctx)
  if (order instanceof Response) return order
  const body = await ctx.input()
  const note = typeof body.note === 'string' ? body.note : body.note == null ? '' : String(body.note)
  if (!note.trim()) {
    return jsonResponse(
      { code: 'rest_missing_callback_param', message: 'Missing parameter(s): note', data: { status: 400, params: ['note'] } },
      400
    )
  }
  const errors = new ParamErrors()
  const customerNote = parseBoolean(errors, 'customer_note', body.customer_note) ?? false
  const addedByUser = parseBoolean(errors, 'added_by_user', body.added_by_user) ?? false
  if (errors.any) return errors.response()

  try {
    const created = await ctx.config.adapter.createOrderNote!(order.id, { note, customerNote, addedByUser })
    if (ctx.config.trackingFromNotes && ctx.config.adapter.onShipmentTrackingCreated) {
      const tracking = parseTrackingFromNote(note)
      if (tracking) {
        await ctx.config.adapter.onShipmentTrackingCreated(order.id, {
          ...tracking,
          dateShipped: new Date().toISOString().slice(0, 10),
        })
      }
    }
    const serialized = serialize(ctx, created)
    return jsonResponse(serialized, 201, {
      Location: `${ctx.apiBase}/${ctx.namespace}/orders/${ctx.params.order_id}/notes/${created.id}`,
    })
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_order_note_error', errorMessage(err, 'Failed to create note.'), 500)
  }
}

export async function deleteOrderNote(ctx: RouteContext): Promise<Response> {
  const errors = new ParamErrors()
  const input = await ctx.input()
  const force = parseBoolean(errors, 'force', input.force) ?? false
  if (errors.any) return errors.response()
  if (!force) {
    return wcErrorResponse('woocommerce_rest_trash_not_supported', 'Resource does not support trashing.', 501)
  }
  const order = await loadOrder(ctx)
  if (order instanceof Response) return order
  try {
    const note = ctx.config.adapter.listOrderNotes ? await findNote(ctx, order) : null
    if (ctx.config.adapter.listOrderNotes && !note) {
      return wcErrorResponse('woocommerce_rest_invalid_id', 'Invalid resource ID.', 404)
    }
    await ctx.config.adapter.deleteOrderNote!(order.id, Number(ctx.params.id))
    return jsonResponse(note ? serialize(ctx, note) : { id: Number(ctx.params.id) })
  } catch (err) {
    return wcErrorResponse('woocommerce_rest_cannot_delete', errorMessage(err, 'The resource cannot be deleted.'), 500)
  }
}
