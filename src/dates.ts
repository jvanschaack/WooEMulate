/**
 * WooEMulate Dates
 * WooCommerce formats REST dates as `YYYY-MM-DDTHH:MM:SS`, without milliseconds or an offset.
 * Plain `date_*` fields use the store's time zone and `*_gmt` fields use UTC.
 */

const formatters = new Map<string, Intl.DateTimeFormat>()

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/** Throws a RangeError when the IANA time zone name is not supported by the runtime. */
export function assertTimeZone(timeZone: string): void {
  zoneFormatter(timeZone)
}

/**
 * Converts adapter input to a Date. Timestamps without an offset are read as UTC so results
 * never depend on the server's local time zone. Returns null for empty or invalid values.
 */
export function toDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value
  const text = String(value).trim()
  const normalized = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text)
    ? text.replace(' ', 'T') + 'Z'
    : text
  const date = new Date(normalized)
  return isNaN(date.getTime()) ? null : date
}

export function formatGmt(date: Date): string {
  return date.toISOString().slice(0, 19)
}

export function formatLocal(date: Date, timeZone = 'UTC'): string {
  if (timeZone === 'UTC') return formatGmt(date)
  const parts: Record<string, string> = {}
  for (const part of zoneFormatter(timeZone).formatToParts(date)) parts[part.type] = part.value
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`
}

/** Returns the local and GMT representations WooCommerce uses for a date field pair. */
export function wcDatePair(
  value: string | Date | null | undefined,
  timeZone = 'UTC'
): { local: string | null; gmt: string | null } {
  const date = toDate(value)
  if (!date) return { local: null, gmt: null }
  return { local: formatLocal(date, timeZone), gmt: formatGmt(date) }
}

/** Offset of the time zone from UTC at the given instant, in milliseconds. */
export function zoneOffsetMs(date: Date, timeZone: string): number {
  if (timeZone === 'UTC') return 0
  const local = formatLocal(date, timeZone)
  const asUtc = Date.parse(local + 'Z')
  return asUtc - Math.floor(date.getTime() / 1000) * 1000
}

/**
 * True when the leading date and time components are real calendar values. `Date.UTC` and
 * `Date.parse` silently roll over values such as February 31 or 24:00.
 */
function hasValidComponents(text: string): boolean {
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/)
  if (!match) return false
  const [y, mo, d, h = 0, mi = 0, s = 0] = match.slice(1).map((part) => (part === undefined ? 0 : Number(part)))
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d &&
    date.getUTCHours() === h && date.getUTCMinutes() === mi && date.getUTCSeconds() === s
  )
}

/** Interprets a wall-clock time (no offset) in the given time zone. */
export function wallTimeToDate(text: string, timeZone: string): Date | null {
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/)
  if (!match || !hasValidComponents(text)) return null
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = match
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  if (isNaN(asUtc)) return null
  if (timeZone === 'UTC') return new Date(asUtc)
  const first = asUtc - zoneOffsetMs(new Date(asUtc), timeZone)
  const second = asUtc - zoneOffsetMs(new Date(first), timeZone)
  const wall = `${y}-${mo}-${d}T${h.padStart(2, '0')}:${mi.padStart(2, '0')}:${s.padStart(2, '0')}`
  if (formatLocal(new Date(second), timeZone) === wall) return new Date(second)
  if (formatLocal(new Date(first), timeZone) === wall) return new Date(first)
  // The wall time falls in a DST gap: move forward, as PHP does (02:30 becomes 03:30).
  return new Date(Math.max(first, second))
}

/**
 * Parses a date query parameter. Values with an explicit offset are absolute. Values without one
 * are read in UTC when `dates_are_gmt` is set and in the store's time zone otherwise.
 */
export function parseDateParam(value: string, datesAreGmt: boolean, timeZone: string): Date | null {
  const text = value.trim()
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) && /T/.test(text)) {
    if (!hasValidComponents(text)) return null
    const date = new Date(text)
    return isNaN(date.getTime()) ? null : date
  }
  return wallTimeToDate(text, datesAreGmt ? 'UTC' : timeZone)
}
