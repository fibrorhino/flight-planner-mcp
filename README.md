# Flight planner MCP

A remote MCP server that lets Claude search Google Flights through SerpApi, including multi-city trips priced as one ticket, and check connection timing.

Hosted on Vercel as project `flight-planner-mcp`, linked to this repo: every push to `main` deploys to production automatically. The connector URL has the form:

    https://flight-planner-mcp-fibrorhinos-projects.vercel.app/<MCP_SECRET>/mcp

Anyone with that URL can spend your SerpApi searches, so keep it private. To change the secret, edit `MCP_SECRET` in Vercel, redeploy, and update the URL in Claude.

## Environment variables (Vercel > Project > Settings > Environment Variables)

| Name | What it is |
|------|------------|
| `SERPAPI_API_KEY` | Your SerpApi key. Add it yourself; it is not in this code. |
| `MCP_SECRET` | The random string in the connector URL. |

Environment variable changes only apply after a redeploy.

## Tools

| Tool | SerpApi credits | What it does |
|------|-----------------|--------------|
| `search_flights` | 1 | One-way or round trip between two places (comma-separated airports allowed). |
| `search_multi_city` | 1 | 2 to 6 legs priced as one ticket. Returns first-leg options. |
| `select_flight` | 1 per step | Pick an option by its `departure_token` to see the next leg or return flight. |
| `get_booking_options` | 1 | Who sells a chosen itinerary and at what price. Does not book. |
| `check_connections` | 0 | Checks gaps between any list of flights: tight, impossible, overnight, airport changes, separate tickets. |

A full 4-city trip therefore costs about 5 searches: the first search, 3 selections, and the booking lookup.

## Test

    npm install
    npm test

The test runs a real MCP client against the handler with SerpApi faked, so it needs no key and spends nothing.

## Notes

- Parameter names come from SerpApi's own README at github.com/serpapi/google-flights-scraper.
- Prices come from Google Flights through SerpApi and can change before you book.
- The server is stateless. Each result includes a `search_context` string that Claude passes back with a token for the next step.
