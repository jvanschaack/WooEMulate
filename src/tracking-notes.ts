/**
 * WooEMulate tracking-note parser
 * Many shipping services write tracking only as free-text order notes. This best-effort parser
 * extracts the tracking number, carrier, and link so adapters can store structured tracking.
 */

import { detectCarrier, getTrackingUrl } from './helpers.js'
import type { WooEmulateTrackingPayload } from './types.js'

const CARRIER_WORDS: Array<[RegExp, string]> = [
  [/\bUSPS\b|United States Postal/i, 'USPS'],
  [/\bUPS\b/, 'UPS'],
  [/\bFed ?Ex\b/i, 'FedEx'],
  [/\bDHL\b/i, 'DHL'],
  [/\bCanada Post\b/i, 'Canada Post'],
  [/\bRoyal Mail\b/i, 'Royal Mail'],
  [/\bAustralia Post\b/i, 'Australia Post'],
  [/\bOnTrac\b/i, 'OnTrac'],
  [/\bPurolator\b/i, 'Purolator'],
  [/\bAsendia\b/i, 'Asendia'],
  [/\bDPD\b/, 'DPD'],
  [/\bGLS\b/, 'GLS'],
]

const CARRIER_HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)usps\.com$/i, 'USPS'],
  [/(^|\.)ups\.com$/i, 'UPS'],
  [/(^|\.)fedex\.com$/i, 'FedEx'],
  [/(^|\.)dhl\.[a-z.]+$/i, 'DHL'],
  [/(^|\.)canadapost(-postescanada)?\.ca$/i, 'Canada Post'],
  [/(^|\.)royalmail\.com$/i, 'Royal Mail'],
  [/(^|\.)auspost\.com\.au$/i, 'Australia Post'],
]

/** Query parameters carriers and tracking pages use for the tracking number. */
const URL_PARAMS = [
  'tLabels', 'tracknum', 'tracknums', 'trknbr', 'AWB', 'tracking_number', 'trackingNumber',
  'tracking_numbers', 'trackNums', 'InquiryNumber1', 'pin', 'trackingId', 'tracking',
]

/** Known tracking-number shapes, tried when the note has no label or link. */
const NUMBER_PATTERNS = [
  /\b1Z[0-9A-Z]{16}\b/i, // UPS
  /\b9[2-5]\d{20}(?:\d{4})?\b/, // USPS IMpb
  /\b[A-Z]{2}\d{9}[A-Z]{2}\b/, // UPU S10 international
]

const LABELED = /tracking(?:\s*(?:number|no\.?|#|code|id))?\s*(?:is|:|#)?\s*:?\s*([A-Z0-9][A-Z0-9-]{6,}(?:\s\d{2,})*)/i

function normalize(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase()
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
}

/**
 * Extracts tracking details from an order-note body (plain text or HTML).
 * Returns null when no tracking number can be found.
 */
export function parseTrackingFromNote(note: string): WooEmulateTrackingPayload | null {
  if (!note) return null
  const decoded = decodeEntities(note)
  const urls = [...decoded.matchAll(/https?:\/\/[^\s"'<>]+/gi)].map((match) => match[0])
  const text = decoded.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')

  let trackingNumber: string | undefined
  let trackingUrl: string | undefined
  for (const href of urls) {
    try {
      const url = new URL(href)
      const param = URL_PARAMS.find((name) => url.searchParams.get(name))
      if (param) {
        trackingNumber = normalize(url.searchParams.get(param)!.split(',')[0])
        trackingUrl = url.href
        break
      }
    } catch {
      // ignore malformed URLs
    }
  }

  if (!trackingNumber) {
    const labeled = text.match(LABELED)
    if (labeled && /\d/.test(labeled[1])) trackingNumber = normalize(labeled[1])
  }
  if (!trackingNumber) {
    const joined = text.replace(/(\d)\s+(?=\d)/g, '$1')
    for (const pattern of NUMBER_PATTERNS) {
      const match = joined.match(pattern)
      if (match) {
        trackingNumber = normalize(match[0])
        break
      }
    }
  }
  if (!trackingNumber || trackingNumber.length < 8) return null

  let carrier = CARRIER_WORDS.find(([pattern]) => pattern.test(text))?.[1]
  if (!carrier && trackingUrl) {
    const host = new URL(trackingUrl).hostname
    carrier = CARRIER_HOSTS.find(([pattern]) => pattern.test(host))?.[1]
  }
  carrier ??= detectCarrier(trackingNumber)

  if (!trackingUrl) {
    trackingUrl = urls.find((href) => normalize(href).includes(trackingNumber!))
  }
  if (!trackingUrl && ['USPS', 'UPS', 'FedEx', 'DHL'].includes(carrier)) {
    trackingUrl = getTrackingUrl(trackingNumber, carrier)
  }

  return { trackingNumber, carrier, ...(trackingUrl ? { trackingUrl } : {}) }
}
