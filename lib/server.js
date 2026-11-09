import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildCommonParams,
  serpapiSearch,
  shapeFlightResults,
  shapeBookingResults,
  decodeContext,
} from "./serpapi.js";
import { checkConnections } from "./connections.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const airports = z
  .string()
  .describe("Uppercase 3-letter IATA airport code, or several separated by commas to search them together (e.g. \"JFK,EWR,LGA\").");
const hours = z
  .string()
  .regex(/^\d{1,2},\d{1,2}(,\d{1,2},\d{1,2})?$/)
  .describe("Time window in local hours: \"dep_from,dep_to\" or \"dep_from,dep_to,arr_from,arr_to\". The end hour is included, so \"6,18\" means 06:00 to 18:59.");

const common = {
  adults: z.number().int().min(1).max(9).optional().describe("Default 1"),
  children: z.number().int().min(0).max(8).optional(),
  infants_in_seat: z.number().int().min(0).max(4).optional(),
  infants_on_lap: z.number().int().min(0).max(4).optional(),
  cabin: z.enum(["economy", "premium_economy", "business", "first"]).optional(),
  stops: z.enum(["any", "nonstop", "max_1_stop", "max_2_stops"]).optional(),
  min_layover_minutes: z.number().int().min(0).optional().describe("Minimum connection time within a leg, in minutes"),
  max_layover_minutes: z.number().int().min(0).optional().describe("Maximum connection time within a leg, in minutes"),
  max_duration_minutes: z.number().int().optional().describe("Maximum total travel time for a leg, in minutes"),
  include_airlines: z.string().optional().describe("Comma-separated IATA airline codes or alliances (STAR_ALLIANCE, SKYTEAM, ONEWORLD). Not with exclude_airlines."),
  exclude_airlines: z.string().optional(),
  exclude_connection_airports: z.string().optional().describe("Comma-separated airport codes never to connect through"),
  max_price: z.number().int().optional(),
  carry_on_bags: z.number().int().min(0).optional(),
  sort_by: z.enum(["top", "price", "departure_time", "arrival_time", "duration", "emissions"]).optional(),
  currency: z.string().length(3).optional().describe("Default USD"),
  country: z.string().length(2).optional().describe("Two-letter country to search from, e.g. us, uk. Prices can differ by country."),
  show_hidden: z.boolean().optional().describe("Include results Google hides behind 'View more flights'"),
  deep_search: z.boolean().optional().describe("Slower, closer to what a browser shows"),
  max_results: z.number().int().min(1).max(30).optional().describe("How many itineraries to return (default 8)"),
};

function asText(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 1) }] };
}

function asError(err) {
  return { isError: true, content: [{ type: "text", text: String(err?.message || err) }] };
}

export function createServer(deps = {}) {
  const search = (params) => serpapiSearch(params, deps);
  const server = new McpServer({ name: "flight-planner", version: "1.0.0" });

  server.registerTool(
    "search_flights",
    {
      title: "Search flights (one-way or round trip)",
      description:
        "Search Google Flights through SerpApi for one origin and destination. Omit return_date for one-way. " +
        "Each result has a price, segments, layovers and tokens. For a round trip, the price shown is for the whole trip, and you pick an outbound flight then call select_flight with its departure_token to see return flights. " +
        "Use booking_token with get_booking_options to see where it can be bought. Each call uses one SerpApi search credit.",
      inputSchema: {
        origin: airports,
        destination: airports,
        date: date.describe("Departure date, YYYY-MM-DD"),
        return_date: date.optional().describe("Omit for one-way"),
        outbound_times: hours.optional(),
        return_times: hours.optional(),
        ...common,
      },
    },
    async (a) => {
      try {
        const p = buildCommonParams(a);
        p.departure_id = a.origin;
        p.arrival_id = a.destination;
        p.outbound_date = a.date;
        if (a.return_date) {
          p.type = 1;
          p.return_date = a.return_date;
          if (a.return_times) p.return_times = a.return_times;
        } else {
          p.type = 2;
        }
        if (a.outbound_times) p.outbound_times = a.outbound_times;
        const json = await search(p);
        return asText(shapeFlightResults(json, p, a.max_results));
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    "search_multi_city",
    {
      title: "Search a multi-city trip as one ticket",
      description:
        "Search Google Flights for a multi-city itinerary (2 to 6 legs) priced together, the way Google's multi-city search does. " +
        "Results are options for the FIRST leg. To continue, call select_flight with the chosen option's departure_token and the search_context; repeat for each leg. " +
        "On the last leg, options carry a booking_token for get_booking_options. Compare the prices against searching each leg one-way: a single ticket can be cheaper or dearer. " +
        "Each step uses one SerpApi search credit.",
      inputSchema: {
        legs: z
          .array(
            z.object({
              from: airports,
              to: airports,
              date: date,
              times: hours.optional(),
            })
          )
          .min(2)
          .max(6),
        ...common,
      },
    },
    async (a) => {
      try {
        const p = buildCommonParams(a);
        p.type = 3;
        p.multi_city_json = JSON.stringify(
          a.legs.map((l) => ({ departure_id: l.from, arrival_id: l.to, date: l.date, ...(l.times ? { times: l.times } : {}) }))
        );
        const json = await search(p);
        const out = shapeFlightResults(json, p, a.max_results);
        out.step = `Leg 1 of ${a.legs.length}`;
        return asText(out);
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    "select_flight",
    {
      title: "Select a flight and see the next leg",
      description:
        "Lock in one option from a round-trip or multi-city search using its departure_token, and get the options for the next leg (return flight, or next city). " +
        "Pass search_context exactly as the previous result gave it. Uses one SerpApi search credit.",
      inputSchema: {
        search_context: z.string(),
        departure_token: z.string(),
        max_results: z.number().int().min(1).max(30).optional(),
      },
    },
    async (a) => {
      try {
        const p = decodeContext(a.search_context);
        const json = await search({ ...p, departure_token: a.departure_token });
        return asText(shapeFlightResults(json, p, a.max_results));
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    "get_booking_options",
    {
      title: "Booking options for a chosen itinerary",
      description:
        "Given a booking_token from a result, list who sells that itinerary (airline direct or agencies), their prices, and baggage prices when Google has them. " +
        "Pass search_context from the same search. This does not book or hold anything. Uses one SerpApi search credit.",
      inputSchema: {
        search_context: z.string(),
        booking_token: z.string(),
      },
    },
    async (a) => {
      try {
        const p = decodeContext(a.search_context);
        const json = await search({ ...p, booking_token: a.booking_token });
        return asText(shapeBookingResults(json));
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    "check_connections",
    {
      title: "Check timing between flights",
      description:
        "Check a planned sequence of flights (from any source: this server, Kiwi, an airline site) for tight, impossible or overnight connections, airport changes and separate-ticket risk. " +
        "Gaps longer than stay_threshold_hours are treated as a planned stay, not a connection. Free: makes no SerpApi calls.",
      inputSchema: {
        flights: z
          .array(
            z.object({
              flight: z.string().optional().describe("e.g. UA 901"),
              label: z.string().optional(),
              from: z.string().describe("Departure airport code"),
              to: z.string().describe("Arrival airport code"),
              depart: z.string().describe("Local departure time, YYYY-MM-DD HH:MM"),
              arrive: z.string().describe("Local arrival time, YYYY-MM-DD HH:MM"),
              ticket: z.string().optional().describe("Any name for the ticket/booking this flight is on. Flights with the same value are on one ticket."),
            })
          )
          .min(2)
          .describe("In travel order"),
        min_same_ticket_minutes: z.number().int().optional().describe("Default 60"),
        min_separate_ticket_minutes: z.number().int().optional().describe("Default 180"),
        min_airport_change_minutes: z.number().int().optional().describe("Default 240"),
        stay_threshold_hours: z.number().optional().describe("Default 24"),
        assume_same_ticket: z.boolean().optional().describe("When ticket is not given, treat flights as one ticket. Default false."),
      },
    },
    async (a) => {
      try {
        return asText(checkConnections(a.flights, a));
      } catch (e) {
        return asError(e);
      }
    }
  );

  return server;
}
