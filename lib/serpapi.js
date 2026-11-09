// Thin client for SerpApi's Google Flights engine.
// Parameter names follow https://github.com/serpapi/google-flights-scraper (SerpApi's own README).

const ENDPOINT = "https://serpapi.com/search";

export const TRAVEL_CLASS = { economy: 1, premium_economy: 2, business: 3, first: 4 };
export const STOPS = { any: 0, nonstop: 1, max_1_stop: 2, max_2_stops: 3 };
export const SORT_BY = { top: 1, price: 2, departure_time: 3, arrival_time: 4, duration: 5, emissions: 6 };

// Turn the tool's friendly options into SerpApi parameters.
export function buildCommonParams(o = {}) {
  const p = {
    engine: "google_flights",
    currency: o.currency || "USD",
    hl: o.language || "en",
  };
  if (o.country) p.gl = o.country;
  if (o.adults != null) p.adults = o.adults;
  if (o.children) p.children = o.children;
  if (o.infants_in_seat) p.infants_in_seat = o.infants_in_seat;
  if (o.infants_on_lap) p.infants_on_lap = o.infants_on_lap;
  if (o.cabin) p.travel_class = TRAVEL_CLASS[o.cabin];
  if (o.stops) p.stops = STOPS[o.stops];
  if (o.sort_by) p.sort_by = SORT_BY[o.sort_by];
  if (o.include_airlines) p.include_airlines = o.include_airlines;
  if (o.exclude_airlines) p.exclude_airlines = o.exclude_airlines;
  if (o.max_price) p.max_price = o.max_price;
  if (o.carry_on_bags) p.bags = o.carry_on_bags;
  if (o.exclude_connection_airports) p.exclude_conns = o.exclude_connection_airports;
  if (o.max_duration_minutes) p.max_duration = o.max_duration_minutes;
  if (o.min_layover_minutes != null || o.max_layover_minutes != null) {
    // SerpApi wants "min,max" in minutes. Fill a missing side with a wide default.
    p.layover_duration = `${o.min_layover_minutes ?? 0},${o.max_layover_minutes ?? 1440}`;
  }
  if (o.show_hidden) p.show_hidden = "true";
  if (o.deep_search) p.deep_search = "true";
  return p;
}

export async function serpapiSearch(params, { apiKey = process.env.SERPAPI_API_KEY, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error("SERPAPI_API_KEY is not set on the server.");
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  qs.set("api_key", apiKey);
  qs.set("output", "json");
  const res = await fetchImpl(`${ENDPOINT}?${qs}`, { signal: AbortSignal.timeout(90000) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`SerpApi returned HTTP ${res.status} with a non-JSON body: ${text.slice(0, 300)}`);
  }
  if (!res.ok && !json.error) throw new Error(`SerpApi returned HTTP ${res.status}`);
  return json;
}

// ---- Search context: the server is stateless, so the parameters of a search are
// handed back to Claude as an opaque string and sent back with a token for the next step.

export function encodeContext(params) {
  const { api_key, departure_token, booking_token, output, ...rest } = params;
  return Buffer.from(JSON.stringify(rest), "utf8").toString("base64url");
}

export function decodeContext(ctx) {
  try {
    const obj = JSON.parse(Buffer.from(ctx, "base64url").toString("utf8"));
    if (!obj || obj.engine !== "google_flights") throw new Error();
    return obj;
  } catch {
    throw new Error("search_context is not valid. Pass back the search_context string exactly as an earlier result gave it.");
  }
}

// ---- Result shaping: keep what matters for planning, drop logos and bulk.

function compactSegment(s) {
  const out = {
    flight: s.flight_number,
    airline: s.airline,
    from: s.departure_airport?.id,
    from_name: s.departure_airport?.name,
    depart: s.departure_airport?.time,
    to: s.arrival_airport?.id,
    to_name: s.arrival_airport?.name,
    arrive: s.arrival_airport?.time,
    minutes: s.duration,
  };
  if (s.airplane) out.aircraft = s.airplane;
  if (s.travel_class) out.cabin = s.travel_class;
  if (s.legroom) out.legroom = s.legroom;
  if (s.overnight) out.overnight = true;
  if (s.often_delayed_by_over_30_min) out.often_delayed_over_30_min = true;
  if (s.ticket_also_sold_by?.length) out.also_sold_by = s.ticket_also_sold_by;
  if (s.extensions?.length) out.notes = s.extensions;
  return out;
}

export function compactItinerary(it, group) {
  const out = {
    group,
    price: it.price,
    total_minutes: it.total_duration,
    route: [it.flights?.[0]?.departure_airport?.id, ...(it.flights || []).map((f) => f.arrival_airport?.id)].join(" > "),
    segments: (it.flights || []).map(compactSegment),
  };
  if (it.layovers?.length) {
    out.layovers = it.layovers.map((l) => ({
      airport: l.id,
      name: l.name,
      minutes: l.duration,
      ...(l.overnight ? { overnight: true } : {}),
    }));
  }
  if (it.type) out.type = it.type;
  if (it.extensions?.length) out.notes = it.extensions;
  if (it.carbon_emissions?.difference_percent != null) out.emissions_vs_typical_pct = it.carbon_emissions.difference_percent;
  if (it.departure_token) out.departure_token = it.departure_token;
  if (it.booking_token) out.booking_token = it.booking_token;
  return out;
}

export function compactPriceInsights(pi) {
  if (!pi) return undefined;
  const out = {
    lowest_price: pi.lowest_price,
    price_level: pi.price_level,
    typical_price_range: pi.typical_price_range,
  };
  if (Array.isArray(pi.price_history) && pi.price_history.length) {
    const prices = pi.price_history.map((p) => p[1]).filter((n) => typeof n === "number");
    if (prices.length) out.price_history_summary = { points: prices.length, min: Math.min(...prices), max: Math.max(...prices), latest: prices[prices.length - 1] };
  }
  return out;
}

export function shapeFlightResults(json, params, limit = 8) {
  if (json.error) {
    return { ok: false, message: json.error, search_context: encodeContext(params) };
  }
  const best = (json.best_flights || []).map((i) => compactItinerary(i, "best"));
  const other = (json.other_flights || []).map((i) => compactItinerary(i, "other"));
  const all = [...best, ...other];
  const out = {
    ok: true,
    currency: params.currency,
    total_found: all.length,
    showing: Math.min(limit, all.length),
    itineraries: all.slice(0, limit),
    search_context: encodeContext(params),
  };
  const pi = compactPriceInsights(json.price_insights);
  if (pi) out.price_insights = pi;
  const gfUrl = json.search_metadata?.google_flights_url;
  if (gfUrl) out.google_flights_url = gfUrl;
  return out;
}

// Booking-options responses vary by stage; strip logos and pass the rest through.
export function stripLogos(v) {
  if (Array.isArray(v)) return v.map(stripLogos);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, val] of Object.entries(v)) {
      if (/logo/i.test(k)) continue;
      o[k] = stripLogos(val);
    }
    return o;
  }
  return v;
}

export function shapeBookingResults(json) {
  if (json.error) return { ok: false, message: json.error };
  const out = { ok: true };
  if (json.selected_flights) out.selected_flights = json.selected_flights.map((i) => compactItinerary(i, "selected"));
  if (json.booking_options) out.booking_options = stripLogos(json.booking_options);
  if (json.baggage_prices) out.baggage_prices = stripLogos(json.baggage_prices);
  const pi = compactPriceInsights(json.price_insights);
  if (pi) out.price_insights = pi;
  const gfUrl = json.search_metadata?.google_flights_url;
  if (gfUrl) out.google_flights_url = gfUrl;
  return out;
}
