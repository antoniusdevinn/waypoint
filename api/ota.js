// Waypoint OTA price comparison — Vercel serverless function.
// Place this file at api/ota.js in the Vercel project (same repo as the
// Waypoint HTML) and redeploy. No API key needed: it reads live fares from
// PriceWin (https://mcp.price.win/mcp), which compares Agoda, Trip.com,
// Traveloka, Booking.com, Kiwi.com and Google Flights from their public
// pages at search time.
//
// GET /api/ota?origin=SIN&dest=TPE&date=2027-05-13&ret=2027-05-17&currency=SGD
//   -> starts a live search, polls briefly, returns what it has so far.
// GET /api/ota?session=<uuid>&currency=SGD
//   -> polls an in-progress search started earlier.
//
// Response:
// { ok:true, status:"searching"|"completed"|"failed", session:"<uuid>",
//   currency:"SGD", out:[...], ret:[...], updatedAt:"..." }
// Each option: { flightNo, airline, departAt, arriveAt, stops, durationMin,
//   price, currency, cheapestAgent, offers:[{agent, price, url}] }
// Prices are converted from USD into the requested currency. The two
// directions are priced as separate one-way tickets, so a round-trip total
// is outbound cheapest + return cheapest.

const PRICEWIN = "https://mcp.price.win/mcp";
const FX_URL = "https://api.exchangerate-api.com/v4/latest/USD";
const POLL_BUDGET_MS = 8000;
const POLL_GAP_MS = 2000;

// Approx fallback rates (USD -> target) used only if the live FX lookup fails.
const FALLBACK_FX = { USD: 1, SGD: 1.34, EUR: 0.92, GBP: 0.79, MYR: 4.47, JPY: 155, INR: 83.5, AUD: 1.52, THB: 36.5 };

let fxCache = { at: 0, rates: null };
async function fxRate(target) {
  if (target === "USD") return 1;
  const now = Date.now();
  if (fxCache.rates && now - fxCache.at < 3600_000) {
    return fxCache.rates[target] || FALLBACK_FX[target] || 1;
  }
  try {
    const r = await fetch(FX_URL);
    const j = await r.json();
    if (j && j.rates) { fxCache = { at: now, rates: j.rates }; return j.rates[target] || FALLBACK_FX[target] || 1; }
  } catch (e) { /* fall through to fallback */ }
  return FALLBACK_FX[target] || 1;
}

/* ----- minimal MCP client (Streamable HTTP, JSON-RPC over SSE) ----- */
async function mcpRpc(method, params, id) {
  const r = await fetch(PRICEWIN, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await r.text();
  const msgs = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) { try { msgs.push(JSON.parse(line.slice(6))); } catch (e) { /* ignore */ } }
  }
  if (!msgs.length) { try { msgs.push(JSON.parse(text)); } catch (e) { msgs.push({ raw: text.slice(0, 300) }); } }
  return msgs;
}

async function mcpTool(name, args) {
  await mcpRpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "waypoint", version: "1.0" } }, 1);
  const res = await mcpRpc("tools/call", { name, arguments: args }, 2);
  const result = (res[0] && res[0].result) || {};
  const text = (result.content || []).map((c) => c.text || "").join("\n");
  return { text, structured: result.structuredContent || null, isError: !!result.isError };
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function normFlights(list, rate, currency) {
  if (!Array.isArray(list)) return [];
  const normed = list.map((f) => {
    const offers = (f.offers || []).map((o) => ({
      agent: o.agent || o.agentCode || "—",
      price: Math.round((o.price || 0) * rate * 100) / 100,
      url: o.bookingUrl || "",
    })).filter((o) => o.price > 0);
    offers.sort((a, b) => a.price - b.price);
    const cheapest = offers[0];
    const departAt = f.departure ? `${f.departure.date} ${f.departure.time}` : "";
    const arriveAt = f.arrival ? `${f.arrival.date} ${f.arrival.time}` : "";
    return {
      flightNo: [f.airlineCode, f.flightNumber].filter(Boolean).join(" ") || f.airline || "",
      airline: f.airline || "",
      departAt,
      arriveAt,
      stops: typeof f.stops === "number" ? f.stops : 0,
      durationMin: f.duration || 0,
      price: cheapest ? cheapest.price : Math.round((f.price || 0) * rate * 100) / 100,
      currency,
      cheapestAgent: cheapest ? cheapest.agent : "",
      offers,
    };
  }).filter((o) => o.price > 0);
  // Cheapest first, keep the payload small — the client shows the top few.
  normed.sort((a, b) => a.price - b.price);
  return normed.slice(0, 12);
}

function toResponse(sc, rate, currency) {
  const status = sc && sc.status ? sc.status : "searching";
  return {
    ok: true,
    status: status === "completed" ? "completed" : status === "failed" ? "failed" : "searching",
    session: (sc && sc.sessionId) || null,
    currency,
    out: normFlights(sc && sc.outboundFlights, rate, currency),
    ret: normFlights(sc && sc.returnFlights, rate, currency),
    updatedAt: new Date().toISOString(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async (req, res) => {
  const q = req.query || {};
  const origin = (q.origin || "").toUpperCase();
  const dest = (q.dest || "").toUpperCase();
  const date = q.date || "";
  const ret = q.ret || "";
  const currency = (q.currency || "USD").toUpperCase();
  const session = q.session || "";

  try {
    const rate = await fxRate(currency);

    // Poll an existing PriceWin search session.
    if (session) {
      const deadline = Date.now() + POLL_BUDGET_MS;
      let last = null;
      for (;;) {
        const p = await mcpTool("poll_flight_results", { sessionId: session, offset: 0, limit: 0 });
        last = p.structured;
        const st = last && last.status;
        if (st === "completed" || st === "failed") break;
        if (Date.now() > deadline) break;
        await sleep(POLL_GAP_MS);
      }
      if (!last) return res.status(200).json({ ok: false, error: "No results for that search session." });
      const out = toResponse(last, rate, currency);
      out.session = session;
      return res.status(200).json(out);
    }

    // Start a new live search.
    if (!origin || !dest || !date) {
      return res.status(200).json({ ok: false, error: "Missing origin, destination or date." });
    }
    const s = await mcpTool("search_flights_live", {
      origin, destination: dest, departureDate: date,
      returnDate: ret || "", adults: 1, cabin: "economy", language: "en",
    });
    const m = (s.text || "").match(UUID_RE);
    const sid = m && m[0];
    if (!sid) {
      return res.status(200).json({ ok: false, error: "Could not start the OTA search. " + (s.text || "").slice(0, 200) });
    }
    const deadline = Date.now() + POLL_BUDGET_MS;
    let last = null;
    for (;;) {
      const p = await mcpTool("poll_flight_results", { sessionId: sid, offset: 0, limit: 0 });
      last = p.structured;
      const st = last && last.status;
      if (st === "completed" || st === "failed") break;
      if (Date.now() > deadline) break;
      await sleep(POLL_GAP_MS);
    }
    if (!last) return res.status(200).json({ ok: false, error: "No results yet — try again in a few seconds." });
    const out = toResponse(last, rate, currency);
    out.session = sid;
    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ ok: false, error: "OTA price check failed: " + (e && e.message ? e.message : e) });
  }
};
