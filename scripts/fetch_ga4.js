// scripts/fetch_ga4.js
// Builds data/ga4.json with daily KPIs + top referrers + top authors (per day)

import fs from "node:fs";
import path from "node:path";
import { BetaAnalyticsDataClient } from "@google-analytics/data";

/**
 * Required env:
 * - GA4_PROPERTY_ID   (e.g. 123456789)
 * - GCP_SA_JSON       (base64-encoded service account JSON)
 * Optional:
 * - GA4_AUTHORS_DIM   (default "customEvent:authors")
 */

const PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const SA_B64 = process.env.GCP_SA_JSON || "";
const AUTHORS_DIM = process.env.GA4_AUTHORS_DIM || "customEvent:authors";

if (!PROPERTY_ID) {
  console.error("Missing GA4_PROPERTY_ID env.");
  process.exit(1);
}
if (!SA_B64) {
  console.error("Missing GCP_SA_JSON (base64) env.");
  process.exit(1);
}

// Decode service account
let sa;
try {
  sa = JSON.parse(Buffer.from(SA_B64, "base64").toString("utf8"));
} catch (e) {
  console.error("Failed to decode GCP_SA_JSON:", e.message);
  process.exit(1);
}

const client = new BetaAnalyticsDataClient({
  credentials: {
    client_email: sa.client_email,
    private_key: sa.private_key,
  },
});

// -------- date helpers (we use "last 7 days" ending yesterday) ----------
function toYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function ymdCompact(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

const today = new Date();
const end = new Date(today);
end.setDate(end.getDate() - 1); // yesterday
const start = new Date(end);
start.setDate(start.getDate() - 6); // last 7 days (incl yesterday)

const startYMD = toYMD(start);
const endYMD = toYMD(end);

// ------------- generic runner -----------------
async function runReport({ dimensions, metrics, limit, orderBys }) {
  const [resp] = await client.runReport({
    property: `properties/${PROPERTY_ID}`,
    dateRanges: [{ startDate: startYMD, endDate: endYMD }],
    dimensions: dimensions.map((name) => ({ name })),
    metrics: metrics.map((name) => ({ name })),
    limit: limit ?? 100000,
    orderBys,
  });
  return resp.rows || [];
}

// ------------- 1) KPIs by date ----------------
// Metrics: totalUsers, newUsers, views, sessions, bounceRate, averageSessionDuration
async function fetchDailyKPIs() {
  const rows = await runReport({
    dimensions: ["date"],
    metrics: [
      "totalUsers",
      "newUsers",
      "views",
      "sessions",
      "bounceRate",
      "averageSessionDuration",
    ],
  });
  const out = {};
  for (const r of rows) {
    const d = r.dimensionValues[0].value; // YYYYMMDD
    out[d] = {
      date: d,
      totalUsers: r.metricValues[0].value || "0",
      newUsers: r.metricValues[1].value || "0",
      pageviews: r.metricValues[2].value || "0", // we store under "pageviews" to match front-end expectations
      sessions: r.metricValues[3].value || "0",
      bounceRate: r.metricValues[4].value || "0",
      averageSessionDuration: r.metricValues[5].value || "0",
      referrers: [],
      authors: [],
    };
  }
  return out; // keyed by YYYYMMDD
}

// ------------- 2) Top referrers (sessionSource) per date ---------------
async function fetchReferrersPerDay() {
  // We’ll group by date + sessionSource and compute totalUsers per group
  const rows = await runReport({
    dimensions: ["date", "sessionSource"],
    metrics: ["totalUsers"],
  });

  const map = new Map(); // date -> array of { source, users }
  for (const r of rows) {
    const d = r.dimensionValues[0].value;
    const source = r.dimensionValues[1].value || "(not set)";
    const users = r.metricValues[0].value || "0";
    if (!map.has(d)) map.set(d, []);
    map.get(d).push({ source, users: users });
  }
  // take top 5 per date
  for (const [d, arr] of map) {
    arr.sort((a, b) => (+b.users || 0) - (+a.users || 0));
    map.set(d, arr.slice(0, 5));
  }
  return map; // Map<date, [{source, users}]>
}

// ------------- 3) Top authors per date (customEvent:authors) ----------
async function fetchAuthorsPerDay() {
  // If your custom dimension appears on events, use customEvent:authors.
  // If it’s registered differently, set GA4_AUTHORS_DIM env to that API name.
  const rows = await runReport({
    dimensions: ["date", AUTHORS_DIM],
    metrics: ["totalUsers", "views"],
  });

  const map = new Map(); // date -> array of { author, users, views }
  for (const r of rows) {
    const d = r.dimensionValues[0].value;
    const author = r.dimensionValues[1].value || "(not set)";
    const users = r.metricValues[0].value || "0";
    const views = r.metricValues[1].value || "0";
    if (!map.has(d)) map.set(d, []);
    map.get(d).push({ author, users, views });
  }
  // take top 10 per date by users
  for (const [d, arr] of map) {
    arr.sort((a, b) => (+b.users || 0) - (+a.users || 0)).reverse();
    map.set(d, arr.slice(0, 10));
  }
  return map; // Map<date, [{author, users, views}]>
}

// ---------------- main -----------------------
(async () => {
  try {
    console.log(
      `Fetching GA4: ${PROPERTY_ID}  ${startYMD} → ${endYMD}  (authors dim: ${AUTHORS_DIM})`
    );

    const [kpisByDate, refsMap, authMap] = await Promise.all([
      fetchDailyKPIs(),
      fetchReferrersPerDay(),
      fetchAuthorsPerDay(),
    ]);

    // merge
    for (
      let d = new Date(start);
      d <= end;
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
    ) {
      const yyyymmdd = ymdCompact(d);
      if (!kpisByDate[yyyymmdd]) {
        // ensure placeholder if GA returns sparse dates
        kpisByDate[yyyymmdd] = {
          date: yyyymmdd,
          totalUsers: "0",
          newUsers: "0",
          pageviews: "0",
          sessions: "0",
          bounceRate: "0",
          averageSessionDuration: "0",
          referrers: [],
          authors: [],
        };
      }
      kpisByDate[yyyymmdd].referrers = refsMap.get(yyyymmdd) || [];
      kpisByDate[yyyymmdd].authors = authMap.get(yyyymmdd) || [];
    }

    const rows = Object.values(kpisByDate).sort(
      (a, b) => a.date.localeCompare(b.date)
    );

    const out = {
      updatedAt: new Date().toISOString(),
      range: { start: startYMD, end: endYMD },
      rows,
    };

    // ensure data folder
    const outDir = path.join(process.cwd(), "data");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const outFile = path.join(outDir, "ga4.json");
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
    console.log(`Wrote ${outFile}  (rows=${rows.length})`);
  } catch (err) {
    console.error("GA4 fetch failed:", err?.message || err);
    process.exit(1);
  }
})();
