// Checks the gaps between consecutive flights in a planned trip.
// Times are local wall-clock times as Google Flights reports them ("YYYY-MM-DD HH:MM").
// A gap measured at one airport is accurate because both times are in that airport's
// time zone. When the airports differ, the gap assumes they share a time zone (true for
// airports in the same city) and the result says so.

function parseLocal(t) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/.exec(String(t).trim());
  if (!m) throw new Error(`Cannot read time "${t}". Use "YYYY-MM-DD HH:MM" local time.`);
  // Treat local wall time as UTC purely to do arithmetic on it.
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

function fmt(mins) {
  const sign = mins < 0 ? "-" : "";
  const a = Math.abs(mins);
  const d = Math.floor(a / 1440);
  const h = Math.floor((a % 1440) / 60);
  const m = a % 60;
  return sign + (d ? `${d}d ` : "") + `${h}h ${String(m).padStart(2, "0")}m`;
}

export function checkConnections(segments, opts = {}) {
  const minSame = opts.min_same_ticket_minutes ?? 60;
  const minSelf = opts.min_separate_ticket_minutes ?? 180;
  const minAirportChange = opts.min_airport_change_minutes ?? 240;
  const stayThreshold = (opts.stay_threshold_hours ?? 24) * 60;

  const segs = segments.map((s, i) => ({
    ...s,
    idx: i + 1,
    from: String(s.from).toUpperCase(),
    to: String(s.to).toUpperCase(),
    dep: parseLocal(s.depart),
    arr: parseLocal(s.arrive),
  }));

  const issues = [];
  const checks = [];

  segs.forEach((s) => {
    if (s.arr <= s.dep && s.from === s.to) issues.push(`Flight ${s.idx} (${s.label || s.flight || ""}) arrives before it departs. Check the times.`);
  });

  for (let i = 0; i < segs.length - 1; i++) {
    const a = segs[i];
    const b = segs[i + 1];
    const gap = Math.round((b.dep - a.arr) / 60000);
    const sameTicket = a.ticket != null && b.ticket != null ? a.ticket === b.ticket : !!opts.assume_same_ticket;
    const airportChange = a.to !== b.from;

    const c = {
      between: `${a.flight || a.label || `flight ${a.idx}`} -> ${b.flight || b.label || `flight ${b.idx}`}`,
      at: airportChange ? `${a.to} then ${b.from}` : a.to,
      arrive: a.arrive,
      depart: b.depart,
      gap: fmt(gap),
      gap_minutes: gap,
      flags: [],
      status: "ok",
    };

    if (gap < 0) {
      c.status = "impossible";
      c.flags.push("Next flight leaves before this one lands.");
    } else if (gap >= stayThreshold) {
      c.kind = "stay";
      if (airportChange) c.flags.push(`You arrive at ${a.to} but leave from ${b.from}. Fine for a stay, just plan the transfer.`);
    } else {
      c.kind = "connection";
      const needed = Math.max(sameTicket ? minSame : minSelf, airportChange ? minAirportChange : 0);
      c.minimum_wanted_minutes = needed;
      if (!sameTicket) c.flags.push("Separate tickets: if the first flight is late, the second airline does not have to rebook you. Allow for re-checking bags and security.");
      if (airportChange) c.flags.push(`Airport change from ${a.to} to ${b.from}. Gap assumes both airports share a time zone.`);
      const aDay = new Date(a.arr).toISOString().slice(0, 10);
      const bDay = new Date(b.dep).toISOString().slice(0, 10);
      if (aDay !== bDay) c.flags.push("Overnight connection: you will need somewhere to sleep or a lounge.");
      if (gap < needed) {
        c.status = gap < needed / 2 ? "too_tight" : "tight";
        c.flags.push(`Only ${fmt(gap)}; you asked for at least ${fmt(needed)} here.`);
      } else if (gap > 6 * 60) {
        c.flags.push("Long layover. Check transit visa rules if you might leave the airport.");
      }
    }
    if (c.status !== "ok") issues.push(`${c.between} at ${c.at}: ${c.status.replace("_", " ")} (${c.gap})`);
    checks.push(c);
  }

  return {
    summary: issues.length ? `${issues.length} problem(s) found.` : "All connections meet your minimums.",
    problems: issues,
    rules_used: {
      min_same_ticket_minutes: minSame,
      min_separate_ticket_minutes: minSelf,
      min_airport_change_minutes: minAirportChange,
      gaps_over_this_many_hours_count_as_a_stay: stayThreshold / 60,
    },
    connections: checks,
    caveat: "Airline and airport minimum connection times vary (international-to-domestic connections and customs often need more). Treat these minimums as your own buffers, not official rules.",
  };
}
