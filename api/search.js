// Waypoint live fares — Vercel serverless function.
// Place this file at api/search.js in the Vercel project (same repo as the
// Waypoint HTML), set SERPAPI_API_KEY in Vercel (Project Settings ->
// Environment Variables), and redeploy.
//
// It answers GET /api/search?origin=SIN&dest=TPE&date=2027-05-13&ret=2027-05-17&currency=SGD
// with { ok:true, offers:[ { flightNo, price, out:{...}, ret:{...}, retOptions:[...] } ] }.
//
// SerpApi Google Flights round-trip is a TWO-STEP flow:
//   Step 1 — the first search (type=1, return_date) returns the OUTBOUND
//   options only. Each itinerary carries a `departure_token` and a price
//   that is the ROUND-TRIP total for that outbound.
//   Step 2 — a second search re-sends the same params PLUS that itinerary's
//   `departure_token`, and returns the matching RETURN flights for it.
// So this function makes the second call for the top few outbound offers
// (to bound SerpApi usage on the free plan) and attaches the return legs.
// Without a return date the offer is one-way (no `ret` field). The price is
// the total for the whole trip (outbound + return) in the requested currency.

const SERPAPI = "https://serpapi.com/search";
const TOP_RETURN_FETCH = 8;   // fetch return legs for every outbound offer
const MAX_RET_OPTIONS = 4;    // return options kept per outbound offer

function legGroup(legs) {
  if (!legs || !legs.length) return null;
  const first = legs[0], last = legs[legs.length - 1];
  return {
    flightNo: first.flight_number || "",
    departAt: first.departure_airport && first.departure_airport.time,
    arriveAt: last.arrival_airport && last.arrival_airport.time,
    stops: Math.max(0, legs.length - 1),
    durationMin: legs.reduce((s, l) => s + (l.duration || 0), 0),
  };
}

function toOffer(it, dest) {
  const legs = it.flights || [];
  // Step-1 itineraries list outbound legs only. (If a response ever does
  // include return legs after the outbound ones, split at the first leg
  // departing from the destination.)
  let split = legs.length;
  for (let i = 0; i < legs.length; i++) {
    const dep = legs[i].departure_airport && legs[i].departure_airport.id;
    if (dep && dep.toUpperCase() === dest.toUpperCase()) { split = i; break; }
  }
  const outLegs = legs.slice(0, split);
  const retLegs = legs.slice(split);
  const out = legGroup(outLegs);
  if (!out) return null;
  const offer = {
    flightNo: out.flightNo,
    price: it.price,
    out,
    departure_token: it.departure_token || null,
  };
  const ret = legGroup(retLegs);
  if (ret) offer.ret = ret;
  return offer;
}

function toReturnOption(it) {
  // A step-2 result: the return legs for one outbound selection.
  const legs = it.flights || [];
  const g = legGroup(legs);
  if (!g) return null;
  return g;
}

async function fetchReturnOptions(baseParams, token) {
  // Second SerpApi call: same search params + departure_token.
  // Returns the matching return flights for that outbound selection.
  const params = new URLSearchParams(baseParams);
  params.set("departure_token", token);
  try {
    const r = await fetch(`${SERPAPI}?${params.toString()}`);
    const j = await r.json();
    if (j.error) return [];
    const its = [...(j.best_flights || []), ...(j.other_flights || [])];
    const out = [];
    for (const it of its) {
      const g = toReturnOption(it);
      if (g) out.push(g);
      if (out.length >= MAX_RET_OPTIONS) break;
    }
    return out;
  } catch (e) {
    return [];
  }
}

module.exports = async (req, res) => {
  const q = req.query || {};
  const origin = (q.origin || "").toUpperCase();
  const dest = (q.dest || "").toUpperCase();
  const date = q.date || "";
  const ret = q.ret || "";
  const currency = (q.currency || "USD").toUpperCase();

  // Bare ping from the client (no params) — just confirm the server is up.
  if (!origin || !dest || !date) {
    return res.status(200).json({ ok: true, offers: [] });
  }

  const key = process.env.SERPAPI_API_KEY;
  if (!key) {
    return res.status(200).json({ ok: false, error: "Missing SerpApi credentials — set SERPAPI_API_KEY in Vercel." });
  }

  const baseParams = new URLSearchParams({
    engine: "google_flights",
    departure_id: origin,
    arrival_id: dest,
    outbound_date: date,
    currency,
    api_key: key,
  });
  if (ret) { baseParams.set("return_date", ret); baseParams.set("type", "1"); }
  else { baseParams.set("type", "2"); }

  try {
    const r = await fetch(`${SERPAPI}?${baseParams.toString()}`);
    const j = await r.json();
    if (j.error) {
      return res.status(200).json({ ok: false, error: String(j.error) });
    }
    const its = [...(j.best_flights || []), ...(j.other_flights || [])];
    const offers = [];
    for (const it of its) {
      const o = toOffer(it, dest);
      if (o && typeof o.price === "number") offers.push(o);
      if (offers.length >= 8) break;
    }

    // Step 2 (round trip only): fetch the return legs for every outbound
    // offer, in parallel, so the client can show the full round trip and
    // coordinate the return departures for any offer the recommendation
    // picks — not just the cheapest few. The offer price stays the step-1
    // round-trip total; the return options supply flight numbers and times.
    if (ret) {
      const withToken = offers
        .filter(o => o.departure_token)
        .sort((a, b) => a.price - b.price)
        .slice(0, TOP_RETURN_FETCH);
      const results = await Promise.all(
        withToken.map(o => fetchReturnOptions(baseParams, o.departure_token))
      );
      withToken.forEach((o, i) => {
        const rets = results[i];
        if (rets.length) {
          o.ret = rets[0];
          o.retOptions = rets;
        }
      });
      offers.forEach(o => delete o.departure_token);
    } else {
      offers.forEach(o => delete o.departure_token);
    }

    return res.status(200).json({ ok: true, offers });
  } catch (e) {
    return res.status(200).json({ ok: false, error: "Live fare lookup failed: " + (e && e.message ? e.message : e) });
  }
};
