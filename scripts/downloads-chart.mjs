#!/usr/bin/env node
/**
 * Redraws docs/assets/downloads.svg — the all-time cumulative npm download
 * curve for this package, from release day (registry `time.created`) to
 * today (UTC). Zero-dependency by policy (README "zero runtime
 * dependencies" invariant): uses global fetch (Node >= 18) against the
 * official endpoints
 *   https://registry.npmjs.org/<pkg>         (first-publish date, versions)
 *   https://api.npmjs.org/downloads/range/…  (per-day download counts)
 * The range endpoint caps requests at ~365 days, so the window is fetched in
 * chunks of 300 days.
 *
 * The series ends at the last SETTLED day (strictly before the current UTC
 * date): npm aggregates per-day counts with roughly one UTC day of lag, so
 * the running day reads 0 all day long — charting it would append a misleading
 * flat tail and stamp the chart "as of" a day whose data does not exist yet.
 * The exact publication time is not guaranteed, so the end day is verified:
 * the authoritative point aggregate over the same window must equal the sum
 * of per-day rows, otherwise the tail day is still unsettled and the series
 * backs off one day at a time (max 7).
 * Output is deterministic; GitHub Actions commits the
 * result once a day (.github/workflows/downloads-chart.yml).
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PKG = "dsh-switchman";
const OUT = fileURLToPath(new URL("../docs/assets/downloads.svg", import.meta.url));
const CHUNK_DAYS = 300;
const UA = "dsh-switchman downloads-chart (github.com/mrzturn/dsh-switchman)";

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

async function getJson(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, { headers: { "user-agent": UA } });
    if (res.ok) return res.json();
    if (attempt === 3) throw new Error(url + " -> HTTP " + res.status);
    await new Promise((r) => setTimeout(r, 800 * attempt));
  }
}

// 1) first publish date
const packument = await getJson("https://registry.npmjs.org/" + PKG);
const created = new Date(packument.time.created.slice(0, 10) + "T00:00:00.000Z"); // UTC midnight: day 1 inclusive
const today = new Date(iso(new Date()) + "T00:00:00.000Z"); // current UTC day, NOT settled
const settled = new Date(today.getTime() - 86400000); // last settled day
if (!(created <= today)) throw new Error("registry created date is in the future");

// 2) daily downloads (chunked; gaps in the API response mean 0 downloads)
const perDay = new Map();
for (let cursor = new Date(created); cursor <= settled; ) {
  const end = addDays(cursor, CHUNK_DAYS - 1) < settled ? addDays(cursor, CHUNK_DAYS - 1) : settled;
  const range = await getJson("https://api.npmjs.org/downloads/range/" + iso(cursor) + ":" + iso(end) + "/" + PKG);
  for (const row of range.downloads ?? []) perDay.set(row.day, row.downloads);
  cursor = addDays(end, 1);
  if (cursor <= settled) await new Promise((r) => setTimeout(r, 250));
}

// 3) settled-day verification: per-day rows are published with ~1 UTC day of
// lag and CDN snapshots vary, so "yesterday" is not guaranteed settled at run
// time. The point aggregate for created..end is authoritative: while it
// exceeds the sum of per-day rows, the tail day is still unsettled — back the
// end off until the two agree (max 7 days), then chart through that day.
let end = settled;
const sumThrough = (limit) => {
  let acc = 0;
  for (let d = new Date(created); d <= limit; d = addDays(d, 1)) acc += perDay.get(iso(d)) ?? 0;
  return acc;
};
for (let guard = 0; guard < 7 && end > created; guard++) {
  const agg = await getJson("https://api.npmjs.org/downloads/point/" + iso(created) + ":" + iso(end) + "/" + PKG);
  const rowsSum = sumThrough(end);
  if (agg.downloads === rowsSum) break;
  if (agg.downloads > rowsSum) {
    console.error("downloads-chart: per-day rows for " + iso(end) + " look unsettled (aggregate " + agg.downloads + " > rows " + rowsSum + "); ending the series a day earlier");
    end = addDays(end, -1);
    continue;
  }
  console.error("downloads-chart: point aggregate behind range sum (" + agg.downloads + " < " + rowsSum + "); keeping per-day rows as fetched");
  break;
}

// 4) cumulative series (through the verified end day)
const days = [];
let cum = 0;
for (let d = new Date(created); d <= end; d = addDays(d, 1)) {
  cum += perDay.get(iso(d)) ?? 0;
  days.push({ date: iso(d), cum });
}
if (days.length === 0) throw new Error("empty series");
const total = days[days.length - 1].cum;

// ---------- SVG rendering (deterministic; GitHub light/dark aware) ----------
const W = 840, H = 300;
const M = { t: 34, r: 26, b: 42, l: 70 };
const iw = W - M.l - M.r, ih = H - M.t - M.b;

function niceStep(rough) {
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(1, rough))));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= rough) return m * pow;
  return 10 * pow;
}
function human(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 ? 1 : 0) + "k";
  return String(n);
}
const fmtInt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const step = niceStep(total / 4);
const yTop = Math.max(step, Math.ceil(Math.max(1, total) / step) * step);
const x = (i) => M.l + (days.length === 1 ? iw / 2 : (i / (days.length - 1)) * iw);
const y = (v) => M.t + ih - (v / yTop) * ih;

let line = "";
days.forEach((p, i) => { line += (i ? " L " : "M ") + x(i).toFixed(1) + " " + y(p.cum).toFixed(1); });
const y0 = y(0).toFixed(1);
const area = line + " L " + x(days.length - 1).toFixed(1) + " " + y0 + " L " + x(0).toFixed(1) + " " + y0 + " Z";

let svg = "";
svg += '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="All-time cumulative npm downloads for ' + PKG + '">';
svg += "<title>" + PKG + " — all-time cumulative npm downloads: " + fmtInt(total) + " as of " + days[days.length - 1].date + "</title>";
svg += '<style>'
  + "text{fill:#57606a;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif}"
  + ".grid{stroke:#afb8c1;stroke-opacity:.35;stroke-width:1}"
  + ".axis{stroke:#afb8c1;stroke-opacity:.7;stroke-width:1}"
  + "@media (prefers-color-scheme: dark){text{fill:#8b949e}.grid{stroke:#8b949e;stroke-opacity:.3}.axis{stroke:#8b949e;stroke-opacity:.6}}"
  + "</style>";
svg += '<defs><linearGradient id="cumGrad" x1="0" y1="0" x2="0" y2="1">'
  + '<stop offset="0" stop-color="#0969da" stop-opacity=".25"/>'
  + '<stop offset="1" stop-color="#0969da" stop-opacity=".02"/>'
  + "</linearGradient></defs>";
svg += '<text x="' + M.l + '" y="20" font-size="14" font-weight="600">'+ PKG + ' — all-time npm downloads (cumulative)</text>';
svg += '<text x="' + (W - M.r) + '" y="20" font-size="11.5" text-anchor="end">total ' + fmtInt(total) + " · through " + days[days.length - 1].date + "</text>";

// grid + y ticks
for (let v = 0; v <= yTop + 1e-9; v += step) {
  const yy = y(v).toFixed(1);
  svg += '<line class="grid" x1="' + M.l + '" y1="' + yy + '" x2="' + (W - M.r) + '" y2="' + yy + '"/>';
  svg += '<text x="' + (M.l - 8) + '" y="' + (+yy + 3.5) + '" font-size="10.5" text-anchor="end">' + human(Math.round(v)) + "</text>";
}
// x ticks (~6 evenly spaced dates)
const stride = Math.max(1, Math.ceil(days.length / 6));
const seenX = new Set();
for (let i = 0; i < days.length; i += stride) {
  const d = days[i].date, xx = x(i).toFixed(1);
  if (seenX.has(xx)) continue; seenX.add(xx);
  svg += '<line class="axis" x1="' + xx + '" y1="' + y0 + '" x2="' + xx + '" y2="' + (+y0 + 4) + '"/>';
  svg += '<text x="' + xx + '" y="' + (+y0 + 17) + '" font-size="10.5" text-anchor="middle">' + MONTHS[+d.slice(5, 7) - 1] + " " + d.slice(8, 10) + "</text>";
}
// baseline
svg += '<line class="axis" x1="' + M.l + '" y1="' + y0 + '" x2="' + (W - M.r) + '" y2="' + y0 + '"/>';
// area + line + end dot
svg += '<path d="' + area + '" fill="url(#cumGrad)"/>';
svg += '<path d="' + line + '" fill="none" stroke="#0969da" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>';
svg += '<circle cx="' + x(days.length - 1).toFixed(1) + '" cy="' + y(total).toFixed(1) + '" r="3.5" fill="#0969da"/>';
svg += "</svg>";

writeFileSync(OUT, svg);
console.log(JSON.stringify({
  out: OUT, bytes: svg.length, firstDay: days[0].date, lastDay: days[days.length - 1].date,
  days: days.length, peakDay: days.reduce((a, d, i) => { const inc = d.cum - (days[i - 1]?.cum ?? 0); return inc > a.inc ? { date: d.date, inc } : a; }, { date: days[0].date, inc: days[0].cum }),
  total, yTop, step,
}));
