import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "../lib/server.js";

// The connector URL is https://<project>.vercel.app/<MCP_SECRET>/mcp
// vercel.json rewrites that to /api/mcp?secret=<MCP_SECRET>.
function secretOk(given) {
  const expected = process.env.MCP_SECRET || "";
  if (!expected || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  if (!secretOk(url.searchParams.get("secret"))) {
    res.statusCode = 404;
    return res.end("Not found");
  }
  if (req.method !== "POST") {
    // Stateless server: no standalone event stream, no sessions to delete.
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    return res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
    }
  }
}
