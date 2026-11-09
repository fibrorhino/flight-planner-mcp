// End-to-end test: real MCP client -> HTTP -> api/mcp.js, with SerpApi faked.
import http from "node:http";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

process.env.MCP_SECRET = "test-secret-123";
process.env.SERPAPI_API_KEY = "fake-key";

const calls = [];
const realFetch = globalThis.fetch;
const itinerary = (from, to, price, extra = {}) => ({
  flights: [
    { departure_airport: { id: from, name: from + " Airport", time: "2027-03-10 08:00" }, arrival_airport: { id: "ORD", name: "O'Hare", time: "2027-03-10 10:00" }, duration: 120, airline: "United", airline_logo: "x.png", flight_number: "UA 1", travel_class: "Economy", often_delayed_by_over_30_min: true },
    { departure_airport: { id: "ORD", name: "O'Hare", time: "2027-03-10 11:00" }, arrival_airport: { id: to, name: to + " Airport", time: "2027-03-10 20:00" }, duration: 480, airline: "United", flight_number: "UA 2", travel_class: "Economy" },
  ],
  layovers: [{ id: "ORD", name: "O'Hare", duration: 60 }],
  total_duration: 720,
  price,
  type: "Multi-city",
  airline_logo: "y.png",
  ...extra,
});
globalThis.fetch = async (url, init) => {
  const u = new URL(url);
  if (u.hostname !== "serpapi.com") return realFetch(url, init);
  const p = Object.fromEntries(u.searchParams);
  calls.push(p);
  let body;
  if (p.booking_token) body = { booking_options: [{ together: { book_with: "United", price: 900, airline_logos: ["z"] } }], search_metadata: { google_flights_url: "https://www.google.com/travel/flights?x" } };
  else if (p.departure_token) body = { best_flights: [itinerary("LHR", "SFO", 900, { booking_token: "BOOK1" })] };
  else if (p.departure_id === "XXX") body = { error: "Google Flights hasn't returned any results for this query." };
  else body = { best_flights: [itinerary("SFO", "LHR", 900, { departure_token: "DEP1" })], other_flights: [itinerary("SFO", "LHR", 1200, { departure_token: "DEP2" })], price_insights: { lowest_price: 900, price_level: "low", typical_price_range: [1000, 1500], price_history: [[1, 1100], [2, 950], [3, 900]] }, search_metadata: { google_flights_url: "https://www.google.com/travel/flights?y" } };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};

const { default: handler } = await import("../api/mcp.js");

// Mimic Vercel: rewrite /<secret>/mcp -> /api/mcp?secret=<secret>, parse JSON body.
const srv = http.createServer(async (req, res) => {
  const m = /^\/([^/]+)\/mcp/.exec(req.url);
  if (m) req.url = `/api/mcp?secret=${m[1]}`;
  let raw = "";
  for await (const c of req) raw += c;
  req.body = raw ? JSON.parse(raw) : undefined;
  handler(req, res);
});
await new Promise((r) => srv.listen(0, r));
const base = `http://127.0.0.1:${srv.address().port}`;

// Wrong secret gets a 404.
assert.equal((await realFetch(`${base}/wrong/mcp`, { method: "POST" })).status, 404);

const client = new Client({ name: "test", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/test-secret-123/mcp`)));

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
assert.deepEqual(tools, ["check_connections", "get_booking_options", "search_flights", "search_multi_city", "select_flight"]);

const parse = (r) => JSON.parse(r.content[0].text);

// Multi-city search
const mc = parse(await client.callTool({ name: "search_multi_city", arguments: {
  legs: [{ from: "SFO", to: "LHR", date: "2027-03-10" }, { from: "LHR", to: "SFO", date: "2027-03-20", times: "6,18" }],
  cabin: "business", stops: "max_1_stop", min_layover_minutes: 90, adults: 2,
} }));
let c = calls.at(-1);
assert.equal(c.type, "3");
assert.equal(c.travel_class, "3");
assert.equal(c.stops, "2");
assert.equal(c.layover_duration, "90,1440");
assert.equal(c.adults, "2");
assert.deepEqual(JSON.parse(c.multi_city_json), [{ departure_id: "SFO", arrival_id: "LHR", date: "2027-03-10" }, { departure_id: "LHR", arrival_id: "SFO", date: "2027-03-20", times: "6,18" }]);
assert.equal(c.outbound_date, undefined);
assert.equal(mc.itineraries.length, 2);
assert.equal(mc.itineraries[0].route, "SFO > ORD > LHR");
assert.equal(mc.itineraries[0].segments[0].often_delayed_over_30_min, true);
assert.ok(!JSON.stringify(mc).includes("logo"));
assert.equal(mc.price_insights.price_history_summary.min, 900);

// Select first leg -> second leg
const sel = parse(await client.callTool({ name: "select_flight", arguments: { search_context: mc.search_context, departure_token: "DEP1" } }));
c = calls.at(-1);
assert.equal(c.departure_token, "DEP1");
assert.equal(c.type, "3");
assert.equal(c.multi_city_json, calls.at(-2).multi_city_json);
assert.equal(c.api_key, "fake-key");
assert.equal(sel.itineraries[0].booking_token, "BOOK1");

// Booking options
const bk = parse(await client.callTool({ name: "get_booking_options", arguments: { search_context: sel.search_context, booking_token: "BOOK1" } }));
c = calls.at(-1);
assert.equal(c.booking_token, "BOOK1");
assert.equal(c.departure_token, undefined);
assert.equal(bk.booking_options[0].together.book_with, "United");
assert.ok(!JSON.stringify(bk).includes("logo"));

// One-way and round trip
await client.callTool({ name: "search_flights", arguments: { origin: "JFK,EWR", destination: "CDG", date: "2027-05-01" } });
assert.equal(calls.at(-1).type, "2");
assert.equal(calls.at(-1).return_date, undefined);
await client.callTool({ name: "search_flights", arguments: { origin: "JFK", destination: "CDG", date: "2027-05-01", return_date: "2027-05-09", return_times: "12,23" } });
assert.equal(calls.at(-1).type, "1");
assert.equal(calls.at(-1).return_times, "12,23");

// SerpApi "no results" comes back as a normal message, not a crash
const none = parse(await client.callTool({ name: "search_flights", arguments: { origin: "XXX", destination: "CDG", date: "2027-05-01" } }));
assert.equal(none.ok, false);
assert.match(none.message, /no results|hasn't returned/i);

// Bad context is rejected clearly
const bad = await client.callTool({ name: "select_flight", arguments: { search_context: "garbage", departure_token: "x" } });
assert.equal(bad.isError, true);

// Connection checker
const cc = parse(await client.callTool({ name: "check_connections", arguments: { flights: [
  { flight: "UA 1", from: "SFO", to: "ORD", depart: "2027-03-10 08:00", arrive: "2027-03-10 14:00", ticket: "A" },
  { flight: "UA 2", from: "ORD", to: "LHR", depart: "2027-03-10 14:40", arrive: "2027-03-11 05:00", ticket: "A" },
  { flight: "U2 9", from: "LGW", to: "BCN", depart: "2027-03-11 06:30", arrive: "2027-03-11 09:30", ticket: "B" },
  { flight: "IB 5", from: "BCN", to: "MAD", depart: "2027-03-15 09:00", arrive: "2027-03-15 10:15", ticket: "C" },
  { flight: "IB 6", from: "MAD", to: "JFK", depart: "2027-03-15 09:30", arrive: "2027-03-15 12:00", ticket: "C" },
] } }));
const st = cc.connections.map((x) => x.status);
assert.deepEqual(st, ["tight", "too_tight", "ok", "impossible"]);
assert.equal(cc.connections[2].kind, "stay");
assert.ok(cc.connections[1].flags.some((f) => f.includes("Airport change")));
assert.ok(cc.connections[1].flags.some((f) => f.includes("Separate tickets")));

await client.close();
srv.close();
console.log(`All checks passed. ${calls.length} fake SerpApi calls made.`);
console.log("Sample connection report:\n" + JSON.stringify(cc.connections[1], null, 1));
