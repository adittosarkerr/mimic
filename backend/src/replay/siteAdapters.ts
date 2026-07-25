import type { AutomationSchema, VariableField } from '../types.js'

/**
 * Per-site adapters — the deterministic path.
 *
 * Generic event-replay is fragile on sites with custom autocompletes and date
 * pickers (Booking.com, GoZayaan): the same recording "works differently every
 * time". For sites we understand, we skip replay entirely and build the site's
 * own results URL from the form values, then scrape results with fixed, known
 * selectors. Same inputs → same URL → same results, every run.
 *
 * An adapter returns null from build() whenever it can't confidently resolve the
 * inputs (e.g. an unmappable city). The caller then falls back to generic replay
 * so we never make a working site worse.
 */

export interface AdapterPlan {
  /** The direct results URL to navigate to. */
  url: string
  /** A selector that, once present, means results have rendered. */
  waitSelector: string
}

export interface SiteAdapter {
  id: string
  label: string
  /** Matches against every URL the recording touched (start + each event), so a
   * sub-service (booking flights vs stays) is told apart by where it navigated. */
  matches(urls: string[]): boolean
  build(schema: AutomationSchema, values: Record<string, string>): AdapterPlan | null
  /** In-page script (string) returning { title, url, results:[{title,href,thumbnail,meta}] }. */
  extractScript: string
}

// --- shared helpers -------------------------------------------------------

const ISO = /^\d{4}-\d{2}-\d{2}$/

function resolved(v: VariableField, values: Record<string, string>): string {
  const raw = values[v.name]
  return (raw !== undefined && raw !== '' ? raw : v.sampleValue) ?? ''
}

/** All date-type fields with a valid ISO value, ascending — earliest first. */
function pickDates(schema: AutomationSchema, values: Record<string, string>): string[] {
  return schema.variables
    .filter((v) => v.type === 'date')
    .map((v) => resolved(v, values))
    .filter((s) => ISO.test(s))
    .sort()
}

/** Today (or today+offset) as a local YYYY-MM-DD — never toISOString() (UTC shift). */
function todayISO(offsetDays = 0): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + offsetDays)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const isFuture = (iso: string) => iso >= todayISO() // lexical compare is valid for ISO dates

/** Resolved ISO value of the first date field whose name/label matches. */
function pickDateVar(
  schema: AutomationSchema,
  values: Record<string, string>,
  test: (nameOrLabel: string) => boolean,
): string | null {
  for (const v of schema.variables) {
    if (v.type !== 'date') continue
    if (!test(v.name) && !test(v.label)) continue
    const val = resolved(v, values)
    if (ISO.test(val)) return val
  }
  return null
}

/** Sum the occupancy steppers into {adults, children, rooms}. */
function pickGuests(schema: AutomationSchema, values: Record<string, string>): {
  adults?: number
  children?: number
  rooms?: number
} {
  const out: { adults?: number; children?: number; rooms?: number } = {}
  for (const v of schema.variables) {
    if (v.kind !== 'guests' || !v.guestType) continue
    const n = parseInt(resolved(v, values), 10)
    if (!Number.isNaN(n)) out[v.guestType] = n
  }
  return out
}

/** Map a recorded currency choice (name / symbol / code) to an ISO code. */
function currencyCode(raw: string | null): string | null {
  if (!raw) return null
  const s = raw.toLowerCase()
  if (/bdt|taka|৳|\btk\b/.test(s)) return 'BDT'
  if (/usd|us dollar|\$|dollar/.test(s)) return 'USD'
  if (/eur|euro|€/.test(s)) return 'EUR'
  if (/gbp|pound|£/.test(s)) return 'GBP'
  if (/inr|rupee|₹/.test(s)) return 'INR'
  if (/aed|dirham/.test(s)) return 'AED'
  if (/sar|riyal/.test(s)) return 'SAR'
  const code = raw.trim().toUpperCase()
  return /^[A-Z]{3}$/.test(code) ? code : null
}

/** First variable whose name OR label matches, returning its resolved value. */
function pickValue(
  schema: AutomationSchema,
  values: Record<string, string>,
  test: (nameOrLabel: string) => boolean,
): string | null {
  for (const v of schema.variables) {
    if (test(v.name) || test(v.label)) {
      const val = resolved(v, values).trim()
      if (val) return val
    }
  }
  return null
}

// --- booking.com (hotels) -------------------------------------------------

/**
 * Map a recorded boolean filter (by its name/label) to Booking's nflt filter
 * code. Codes verified live against Booking's own filter chips. Returns null for
 * toggles that aren't URL filters (e.g. "traveling for work", "couples").
 */
function bookingFilterCode(text: string): string | null {
  const s = text.toLowerCase()
  if (/5[\s-]*star|five star/.test(s)) return 'class=5'
  if (/4[\s-]*star|four star/.test(s)) return 'class=4'
  if (/3[\s-]*star|three star/.test(s)) return 'class=3'
  if (/breakfast/.test(s)) return 'mealplan=1'
  if (/free cancel/.test(s)) return 'fc=2'
  if (/swimming|\bpool\b/.test(s)) return 'hotelfacility=433'
  if (/air.?condition/.test(s)) return 'roomfacility=11'
  if (/wi.?fi|wifi|internet/.test(s)) return 'hotelfacility=107'
  if (/parking/.test(s)) return 'hotelfacility=2'
  if (/very good|guest.*\b8|review.*\b8|8\+/.test(s)) return 'review_score=80'
  if (/\bhotels?\b/.test(s)) return 'ht_id=204'
  return null
}

const bookingAdapter: SiteAdapter = {
  id: 'booking-stays',
  label: 'Booking.com hotels',
  // Stays is the default booking service, but must NOT hijack a cars / flights /
  // attractions / taxi recording (they'd wrongly become a hotel search).
  matches: (urls) =>
    urls.some((u) => /booking\.com/i.test(u)) &&
    !urls.some((u) =>
      /booking\.com\/(cars|flights?|attractions|taxi)|cars\.booking|flights\.booking|booking\.kayak/i.test(u),
    ),
  build(schema, values) {
    // Defense-in-depth: a cars recording (pick-up / drop-off) or a flights
    // recording (origin + destination) must never be built as a hotel search.
    const fields = schema.variables.map((v) => `${v.name} ${v.label}`).join(' ')
    if (/pick.?up|drop.?off/i.test(fields)) return null
    if (/\borigin\b/i.test(fields) && /destinat/i.test(fields)) return null

    // Destination: prefer an explicitly named field, else the first free-text /
    // autocomplete input that isn't a date or a guest counter.
    let dest = pickValue(schema, values, (s) =>
      /destinat|where|city|going|stay|location|search|\bto\b/i.test(s),
    )
    if (!dest) {
      const textVar = schema.variables.find(
        (v) => v.type === 'text' && v.kind !== 'guests' && (v.autocomplete || v.kind === 'input'),
      )
      if (textVar) dest = resolved(textVar, values).trim() || null
    }
    if (!dest) return null

    const dates = pickDates(schema, values)
    // Identify check-in vs check-out by field name (robust); fall back to the
    // sorted pair. Past dates are dropped — a live calendar can't book them.
    let checkIn = pickDateVar(schema, values, (s) => /check.?in|arriv/i.test(s)) ?? dates[0]
    let checkOut = pickDateVar(schema, values, (s) => /check.?out|depart|leav/i.test(s)) ?? dates[1]
    if (checkIn && !isFuture(checkIn)) checkIn = undefined as unknown as string
    if (checkOut && (!isFuture(checkOut) || (checkIn && checkOut <= checkIn))) checkOut = undefined as unknown as string

    const guests = pickGuests(schema, values)
    const adults = Math.max(1, guests.adults ?? 2)
    const children = Math.max(0, guests.children ?? 0)
    const rooms = Math.max(1, guests.rooms ?? 1)

    // Checked filters → Booking's nflt param (5 stars, breakfast, pool, …).
    const filterCodes: string[] = []
    for (const v of schema.variables) {
      if (v.type !== 'boolean') continue
      if (resolved(v, values) !== 'true') continue
      const code = bookingFilterCode(`${v.name} ${v.label}`)
      if (code && !filterCodes.includes(code)) filterCodes.push(code)
    }

    const p = new URLSearchParams()
    p.set('ss', dest)
    if (checkIn) p.set('checkin', checkIn)
    if (checkOut) p.set('checkout', checkOut)
    p.set('group_adults', String(adults))
    p.set('group_children', String(children))
    p.set('no_rooms', String(rooms))
    if (filterCodes.length) p.set('nflt', filterCodes.join(';'))
    const cur = currencyCode(pickValue(schema, values, (s) => /currency|curr\b/i.test(s)))
    if (cur) p.set('selected_currency', cur)
    // Booking requires an age per child or it bounces to an age prompt.
    let url = `https://www.booking.com/searchresults.html?${p.toString()}`
    for (let i = 0; i < children; i++) url += `&age=8`

    return { url, waitSelector: '[data-testid="property-card"]' }
  },
  extractScript: `(() => {
    const abs = (u) => { try { return u ? new URL(u, location.href).toString() : null } catch { return null } };
    const clean = (t) => (t || '').trim().replace(/\\s+/g, ' ');
    const cards = Array.from(document.querySelectorAll('[data-testid="property-card"]')).slice(0, 40);
    const results = [];
    for (const card of cards) {
      const title = clean((card.querySelector('[data-testid="title"]') || {}).textContent);
      if (!title) continue;
      const linkEl = card.querySelector('a[href]');
      const href = linkEl ? abs(linkEl.getAttribute('href')) : null;
      const img = card.querySelector('img');
      let thumb = img ? abs(img.currentSrc || img.src || img.getAttribute('data-src')) : null;
      if (thumb && thumb.startsWith('data:')) thumb = null;
      const price = clean((card.querySelector('[data-testid="price-and-discounted-price"]') || {}).textContent);
      let score = clean((card.querySelector('[data-testid="review-score"]') || {}).textContent)
        .replace(/^Scored\\s+[\\d.]+\\s+/i, '')
        .replace(/([\\d.])([A-Za-z])/, '$1 $2');
      const dist = clean((card.querySelector('[data-testid="distance"]') || {}).textContent);
      const meta = [price, score, dist].filter((t) => t && t.length > 0).slice(0, 4);
      results.push({ title: title.slice(0, 160), href, thumbnail: thumb, meta });
    }
    return { title: document.title, url: location.href, results };
  })()`,
}

// --- gozayaan.com (flights) ----------------------------------------------

/** City / airport name → IATA. Comprehensive for a Bangladesh OTA: every
 * domestic airport + the international cities GoZayaan actually sells. */
const CITY_IATA: Record<string, string> = {
  // Bangladesh domestic
  dhaka: 'DAC', chittagong: 'CGP', chattogram: 'CGP', coxsbazar: 'CXB', cox: 'CXB',
  sylhet: 'ZYL', jessore: 'JSR', jashore: 'JSR', saidpur: 'SPD', rajshahi: 'RJH',
  barisal: 'BZL', barishal: 'BZL',
  // South Asia
  kolkata: 'CCU', calcutta: 'CCU', delhi: 'DEL', newdelhi: 'DEL', mumbai: 'BOM', bombay: 'BOM',
  chennai: 'MAA', madras: 'MAA', bangalore: 'BLR', bengaluru: 'BLR', hyderabad: 'HYD',
  kochi: 'COK', cochin: 'COK', ahmedabad: 'AMD', goa: 'GOI', guwahati: 'GAU',
  kathmandu: 'KTM', male: 'MLE', maldives: 'MLE', colombo: 'CMB',
  karachi: 'KHI', lahore: 'LHE', islamabad: 'ISB', paro: 'PBH', thimphu: 'PBH',
  // Middle East
  dubai: 'DXB', abudhabi: 'AUH', sharjah: 'SHJ', doha: 'DOH', jeddah: 'JED',
  riyadh: 'RUH', dammam: 'DMM', medina: 'MED', madinah: 'MED', muscat: 'MCT',
  bahrain: 'BAH', manama: 'BAH', kuwait: 'KWI', amman: 'AMM', beirut: 'BEY',
  // SE / East Asia
  kualalumpur: 'KUL', penang: 'PEN', singapore: 'SIN', bangkok: 'BKK', phuket: 'HKT',
  jakarta: 'CGK', bali: 'DPS', denpasar: 'DPS', manila: 'MNL', hochiminh: 'SGN',
  saigon: 'SGN', hanoi: 'HAN', yangon: 'RGN', phnompenh: 'PNH', hongkong: 'HKG',
  guangzhou: 'CAN', beijing: 'PEK', shanghai: 'PVG', kunming: 'KMG', seoul: 'ICN',
  tokyo: 'NRT', osaka: 'KIX', taipei: 'TPE',
  // Europe
  london: 'LHR', manchester: 'MAN', paris: 'CDG', frankfurt: 'FRA', amsterdam: 'AMS',
  istanbul: 'IST', rome: 'FCO', milan: 'MXP', madrid: 'MAD', barcelona: 'BCN',
  munich: 'MUC', zurich: 'ZRH', vienna: 'VIE', brussels: 'BRU', dublin: 'DUB',
  moscow: 'SVO', athens: 'ATH', lisbon: 'LIS', copenhagen: 'CPH', stockholm: 'ARN',
  // North America (cities + a few states → their primary airport, best-effort)
  newyork: 'JFK', newark: 'EWR', dallas: 'DFW', texas: 'DFW', houston: 'IAH',
  losangeles: 'LAX', california: 'LAX', sanfrancisco: 'SFO', chicago: 'ORD',
  miami: 'MIA', florida: 'MIA', atlanta: 'ATL', washington: 'IAD', boston: 'BOS',
  seattle: 'SEA', lasvegas: 'LAS', orlando: 'MCO', toronto: 'YYZ', vancouver: 'YVR',
  montreal: 'YUL',
  // Oceania / Africa
  sydney: 'SYD', melbourne: 'MEL', cairo: 'CAI', nairobi: 'NBO', johannesburg: 'JNB',
}

/**
 * Resolve a city/airport name (or a code the user typed) to an IATA code.
 * Order matters: an exact city-name hit beats the 3-letter-code heuristic, so
 * "Goa" → GOI (its real code), not "GOA".
 */
function toIata(raw: string): string | null {
  if (!raw) return null
  const s = raw.trim()
  const key = s.toLowerCase().replace(/[^a-z]/g, '')
  if (key && CITY_IATA[key]) return CITY_IATA[key] // exact city name
  if (/^[A-Z]{3}$/.test(s)) return s // an explicit UPPERCASE code (e.g. "DAC")
  const m = s.match(/[(,]\s*([A-Za-z]{3})\b/) // "Dhaka (DAC)" / "Dhaka DAC, Airport"
  if (m) return m[1].toUpperCase()
  if (!key) return null
  for (const [name, iata] of Object.entries(CITY_IATA)) {
    if (key.includes(name)) return iata
  }
  return null
}

function cabinClass(raw: string | null): string {
  const s = (raw ?? '').toLowerCase()
  if (/business/.test(s)) return 'Business'
  if (/first/.test(s)) return 'First'
  if (/premium/.test(s)) return 'Premium Economy'
  return 'Economy'
}

const gozayaanAdapter: SiteAdapter = {
  id: 'gozayaan-flight',
  label: 'GoZayaan flights',
  // Flights is GoZayaan's default service. Don't hijack a hotel/tour/visa
  // recording (those need place-IDs we can't build) — let those fall back.
  matches: (urls) =>
    urls.some((u) => /gozayaan\.com/i.test(u)) && !urls.some((u) => /gozayaan\.com\/(hotel|tour|visa)/i.test(u)),
  build(schema, values) {
    const originRaw = pickValue(schema, values, (s) => /^from$|origin|leav|source|depart.*from/i.test(s))
    const destRaw = pickValue(schema, values, (s) => /^to$|destinat|going|arriv/i.test(s))
    const origin = toIata(originRaw ?? '')
    const destination = toIata(destRaw ?? '')
    // Can't resolve both airports → let generic replay try instead.
    if (!origin || !destination) return null

    // Departure vs return by field name (robust); never let a stale past date
    // become the departure. If departure is missing/past, default to a week out
    // so the adapter always builds a valid future search (no broken replay).
    const dates = pickDates(schema, values)
    let departDate = pickDateVar(schema, values, (s) => /depart|onward|leav|going/i.test(s)) ?? dates.find(isFuture) ?? dates[0]
    let returnDate = pickDateVar(schema, values, (s) => /return|inbound|back|coming/i.test(s)) ?? dates[1]
    if (!departDate || !isFuture(departDate)) departDate = todayISO(7)
    if (returnDate && (!isFuture(returnDate) || returnDate <= departDate)) returnDate = undefined as unknown as string

    const cabin = cabinClass(pickValue(schema, values, (s) => /cabin|class/i.test(s)))
    const guests = pickGuests(schema, values)
    const travellers = pickValue(schema, values, (s) => /travel|passenger|adult|guest/i.test(s))
    const adult = guests.adults && guests.adults > 0 ? guests.adults : parseInt(travellers ?? '1', 10) || 1
    const child = guests.children && guests.children > 0 ? guests.children : 0
    const infant = 0

    const p = new URLSearchParams()
    p.set('origin', origin)
    p.set('destination', destination)
    p.set('departure_date', departDate)
    if (returnDate) p.set('return_date', returnDate)
    p.set('adult', String(adult))
    p.set('child', String(child))
    p.set('infant', String(infant))
    p.set('class', cabin)
    p.set('cabin_class', cabin)
    p.set('trip_type', returnDate ? 'roundway' : 'oneway')
    p.set('trips', `${origin},${destination},${departDate}`)

    return { url: `https://gozayaan.com/flight/list?${p.toString()}`, waitSelector: '.flight-card' }
  },
  extractScript: `(() => {
    const abs = (u) => { try { return u ? new URL(u, location.href).toString() : null } catch { return null } };
    const clean = (t) => (t || '').trim().replace(/\\s+/g, ' ');
    const cards = Array.from(document.querySelectorAll('.flight-card')).slice(0, 40);
    const results = [];
    for (const card of cards) {
      const img = card.querySelector('img');
      const airline = clean((card.querySelector('.airline-name') || {}).textContent) || (img ? img.alt : '');
      if (!airline) continue;
      const dep = clean((card.querySelector('.start-time .time-text') || {}).textContent);
      const arr = clean((card.querySelector('.end-time .time-text') || {}).textContent);
      const stops = clean((card.querySelector('.stop-text') || {}).textContent);
      const priceEl = card.querySelector('.price-and-currency') || card.querySelector('.price-text');
      let price = clean(priceEl ? priceEl.textContent : '');
      if (price && !/[A-Za-z]/.test(price)) price = 'BDT ' + price;
      let thumb = img ? abs(img.currentSrc || img.src) : null;
      if (thumb && thumb.startsWith('data:')) thumb = null;
      const route = [dep, arr].filter(Boolean).join(' \\u2192 ');
      const meta = [route, stops, price].filter((t) => t && t.length > 0).slice(0, 4);
      results.push({ title: airline.slice(0, 120), href: location.href, thumbnail: thumb, meta });
    }
    return { title: document.title, url: location.href, results };
  })()`,
}

// --- booking.com flights (redirects to booking.kayak.com) -----------------

const bookingFlightAdapter: SiteAdapter = {
  id: 'booking-flight',
  label: 'Booking.com flights',
  matches: (urls) => urls.some((u) => /booking\.kayak\.com|flights\.booking\.com|booking\.com\/flight/i.test(u)),
  build(schema, values) {
    // The flights form is often mislabeled by synthesis (e.g. "Check-in" for a
    // departure), so match origin/destination + dates by every plausible name.
    const origin = toIata(pickValue(schema, values, (s) => /^from$|origin|leav|source|depart.*from/i.test(s)) ?? '')
    const destination = toIata(pickValue(schema, values, (s) => /^to$|destinat|going|arriv/i.test(s)) ?? '')
    if (!origin || !destination) return null

    const dates = pickDates(schema, values)
    let departDate = pickDateVar(schema, values, (s) => /depart|check.?in|onward|leav|going/i.test(s)) ?? dates.find(isFuture) ?? dates[0]
    let returnDate = pickDateVar(schema, values, (s) => /return|check.?out|inbound|back|coming/i.test(s)) ?? dates[1]
    if (!departDate || !isFuture(departDate)) departDate = todayISO(7)
    if (returnDate && (!isFuture(returnDate) || returnDate <= departDate)) returnDate = undefined as unknown as string

    const guests = pickGuests(schema, values)
    const travellers = pickValue(schema, values, (s) => /travel|passenger|adult|guest/i.test(s))
    const adults = Math.max(1, guests.adults ?? (parseInt(travellers ?? '1', 10) || 1))

    // booking.kayak.com/flights/DFW-DAC/2026-07-30/2026-08-19/2adults?sort=bestflight_a
    const legs = returnDate ? `${departDate}/${returnDate}` : `${departDate}`
    const url = `https://booking.kayak.com/flights/${origin}-${destination}/${legs}/${adults}adults?sort=bestflight_a`
    return { url, waitSelector: '.nrc6' }
  },
  // Kayak's class names are obfuscated + volatile, so read fields by text pattern
  // (airline from the logo alt) — robust across their frequent markup churn.
  extractScript: `(() => {
    const clean = (t) => (t || '').trim().replace(/\\s+/g, ' ');
    const cards = Array.from(document.querySelectorAll('.nrc6')).slice(0, 40);
    const results = [];
    const seen = new Set();
    for (const card of cards) {
      const t = clean(card.textContent);
      const img = card.querySelector('img');
      const airline = (img && img.alt) ? img.alt : 'Flight';
      const times = t.match(/\\d{1,2}:\\d{2}\\s*[ap]m\\s*[\\u2013-]\\s*\\d{1,2}:\\d{2}\\s*[ap]m/gi) || [];
      const durs = (t.match(/\\d+h\\s*\\d+m/gi) || [])
        .map((d) => { const m = d.match(/(\\d+)h\\s*(\\d+)m/i); return { d: d, min: (+m[1]) * 60 + (+m[2]) }; })
        .sort((a, b) => b.min - a.min);
      const dur = durs[0] ? durs[0].d : null;
      const stops = (t.match(/nonstop|\\d+\\s*stops?/i) || [])[0];
      const price = (t.match(/(?:Tk|BDT|\\u09f3|\\$|\\u20ac|\\u00a3)\\s?[\\d,]+/) || [])[0];
      const key = airline + '|' + (times[0] || '') + '|' + (price || '');
      if (seen.has(key)) continue; seen.add(key);
      const meta = [times[0], dur, stops, price].filter((x) => x && x.length > 0).slice(0, 4);
      results.push({ title: airline.slice(0, 120), href: location.href, thumbnail: null, meta });
      if (results.length >= 40) break;
    }
    return { title: document.title, url: location.href, results };
  })()`,
}

// --- booking.com attractions ----------------------------------------------

/** City → ISO country code, for building attraction result URLs. */
const CITY_CC: Record<string, string> = {
  dhaka: 'bd', chittagong: 'bd', chattogram: 'bd', coxsbazar: 'bd', cox: 'bd', sylhet: 'bd',
  kolkata: 'in', calcutta: 'in', delhi: 'in', newdelhi: 'in', mumbai: 'in', bombay: 'in',
  chennai: 'in', bangalore: 'in', bengaluru: 'in', hyderabad: 'in', kochi: 'in', goa: 'in',
  jaipur: 'in', agra: 'in', kathmandu: 'np', male: 'mv', maldives: 'mv', colombo: 'lk',
  karachi: 'pk', lahore: 'pk', islamabad: 'pk',
  bangkok: 'th', phuket: 'th', chiangmai: 'th', kualalumpur: 'my', penang: 'my',
  singapore: 'sg', jakarta: 'id', bali: 'id', denpasar: 'id', manila: 'ph',
  hochiminh: 'vn', hanoi: 'vn', yangon: 'mm', phnompenh: 'kh', siemreap: 'kh',
  hongkong: 'hk', guangzhou: 'cn', beijing: 'cn', shanghai: 'cn', seoul: 'kr',
  tokyo: 'jp', osaka: 'jp', kyoto: 'jp', taipei: 'tw',
  dubai: 'ae', abudhabi: 'ae', sharjah: 'ae', doha: 'qa', jeddah: 'sa', riyadh: 'sa',
  mecca: 'sa', medina: 'sa', muscat: 'om', manama: 'bh', kuwait: 'kw', amman: 'jo', beirut: 'lb',
  london: 'gb', manchester: 'gb', edinburgh: 'gb', paris: 'fr', nice: 'fr', frankfurt: 'de',
  munich: 'de', berlin: 'de', amsterdam: 'nl', istanbul: 'tr', rome: 'it', milan: 'it',
  venice: 'it', florence: 'it', madrid: 'es', barcelona: 'es', zurich: 'ch', vienna: 'at',
  brussels: 'be', dublin: 'ie', athens: 'gr', lisbon: 'pt', prague: 'cz', copenhagen: 'dk',
  stockholm: 'se', moscow: 'ru',
  newyork: 'us', losangeles: 'us', sanfrancisco: 'us', lasvegas: 'us', miami: 'us',
  orlando: 'us', chicago: 'us', boston: 'us', washington: 'us', seattle: 'us', honolulu: 'us',
  toronto: 'ca', vancouver: 'ca', montreal: 'ca', sydney: 'au', melbourne: 'au',
  cairo: 'eg', nairobi: 'ke', johannesburg: 'za', capetown: 'za', marrakesh: 'ma',
}

const bookingAttractionsAdapter: SiteAdapter = {
  id: 'booking-attractions',
  label: 'Booking.com attractions',
  matches: (urls) => urls.some((u) => /booking\.com\/attractions/i.test(u)),
  build(schema, values) {
    const city = pickValue(schema, values, (s) => /destinat|where|city|going|location|attraction|search|\bto\b/i.test(s))
    if (!city) return null
    const key = city.toLowerCase().replace(/[^a-z]/g, '')
    // resolve country: exact map hit, else any city name contained in the input
    let cc = CITY_CC[key]
    if (!cc) for (const [name, code] of Object.entries(CITY_CC)) if (key.includes(name)) { cc = code; break }
    if (!cc) return null
    const slug = city.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const cur = currencyCode(pickValue(schema, values, (s) => /currency|curr\b/i.test(s)))
    const q = cur ? `?selected_currency=${cur}` : ''
    return { url: `https://www.booking.com/attractions/searchresults/${cc}/${slug}.html${q}`, waitSelector: '[data-testid="card"]' }
  },
  extractScript: `(() => {
    const abs = (u) => { try { return u ? new URL(u, location.href).toString() : null } catch { return null } };
    const clean = (t) => (t || '').trim().replace(/\\s+/g, ' ');
    const cards = Array.from(document.querySelectorAll('[data-testid="card"]')).slice(0, 40);
    const results = [];
    const seen = new Set();
    for (const card of cards) {
      const title = clean((card.querySelector('[data-testid="card-title"]') || {}).textContent);
      if (!title || seen.has(title)) continue; seen.add(title);
      const a = card.querySelector('a[href]');
      const href = a ? abs(a.getAttribute('href')) : null;
      const img = card.querySelector('img');
      let thumb = img ? abs(img.currentSrc || img.src) : null;
      if (thumb && thumb.startsWith('data:')) thumb = null;
      let price = clean((card.querySelector('[data-testid="price"]') || {}).textContent);
      const pm = price.match(/(?:€|\\$|£|₹|BDT|Tk|USD)\\s?[\\d,]+/);
      price = pm ? 'From ' + pm[0].replace(/^\\s+/, '') : '';
      let score = clean((card.querySelector('[data-testid="review-score"]') || {}).textContent);
      const sm = score.match(/([\\d.]+)\\s*·?\\s*(Exceptional|Excellent|Wonderful|Superb|Fabulous|Very good|Good|Pleasant|Average)/i);
      score = sm ? sm[1] + ' · ' + sm[2] : '';
      const meta = [price, score].filter((t) => t && t.length > 0).slice(0, 3);
      results.push({ title: title.slice(0, 160), href, thumbnail: thumb, meta });
    }
    return { title: document.title, url: location.href, results };
  })()`,
}

// --- registry -------------------------------------------------------------

// Order matters: getAdapter returns the FIRST match, so specific sub-services
// (flights) come before the domain-wide fallback (booking stays).
const ADAPTERS: SiteAdapter[] = [bookingFlightAdapter, bookingAttractionsAdapter, bookingAdapter, gozayaanAdapter]

export function getAdapter(urls: Array<string | undefined | null>): SiteAdapter | null {
  const clean = urls.filter((u): u is string => typeof u === 'string' && u.length > 0)
  return ADAPTERS.find((a) => a.matches(clean)) ?? null
}
