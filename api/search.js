// Waypoint live fares — Vercel serverless function.
// Place this file at api/search.js in the Vercel project (same repo as the
// Waypoint HTML), set SERPAPI_API_KEY in Vercel (Project Settings ->
// Environment Variables), and redeploy.
//
// It answers GET /api/search?origin=SIN&dest=TPE&date=2027-05-13&ret=2027-05-17&currency=SGD
// with { ok:true, offers:[ { flightNo, price, out:{...}, ret:{...} } ] }.
// The `ret` leg is included whenever a return date is given, so the client
// can show the inbound flight. Without a return date the offer is one-way
// (no `ret` field). The price is the total for the whole trip (outbound +
// return) in the requested currency.

const SERPAPI = "https://serpapi.com/search";

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
  // Round-trip itineraries list outbound legs first, then the return legs.
  // The return starts at the first leg that departs from the destination.
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
  };
  const ret = legGroup(retLegs);
  if (ret) offer.ret = ret;
  return offer;
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

  const params = new URLSearchParams({
    engine: "google_flights",
    departure_id: origin,
    arrival_id: dest,
    outbound_date: date,
    currency,
    api_key: key,
  });
  if (ret) { params.set("return_date", ret); params.set("type", "1"); }
  else { params.set("type", "2"); }

  try {
    const r = await fetch(`${SERPAPI}?${params.toString()}`);
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
    return res.status(200).json({ ok: true, offers });
  } catch (e) {
    return res.status(200).json({ ok: false, error: "Live fare lookup failed: " + (e && e.message ? e.message : e) });
  }
};
