// scripts/fetch_ga4.js
// Creates data/ga4.json with daily KPIs + top referrers + top authors

import fs from "node:fs";
import path from "node:path";
import { BetaAnalyticsDataClient } from "@google-analytics/data";

// ---- required env ----
const PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const SA_B64 = process.env.GCP_SA_JSON || "";

// Preferred authors dimension; we’ll fall back if it yields 0 rows.
const PREFERRED_AUTHORS_DIM = process.env.GA4_AUTHORS_DIM || "customEvent:authors";
// Fallbacks we’ll try in order if authors rows are empty:
const AUTHOR_DIM_CANDIDATES = [
  PREFERRED_AUTHORS_DIM,          // first: your explicit choice
  "customEvent:authors",          // common
  "customEvent:authorName",       // common alt
  "customEvent:author",           // sometimes used
  "customEvent:byline",           // rare, but try
];

if (!PROPERTY_ID) {
  console.error("❌ Missing GA4_PROPERTY_ID env.");
  process.exit(1);
}
if (!SA_B64) {
  console.error("❌ Missing GCP_SA_JSON (base64) env.");
  process.exit(1);
}

// decode service account
let sa;
try {
  sa = JSON.parse(Buffer.from(SA_B64, "base64").toString("utf8"));
} catch (e) {
  console.error("❌ Failed to decode GCP_SA_JSON:", e.message);
  process.exit(1);
}

const client = new BetaAnalyticsDataClient({
  credentials: {
    client_email: sa.client_email,
    private_key: sa.private_key,
  },
});

// ---- date helpers (last 7 days ending yesterday) ----
function toYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function yyyymmdd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

const today = new Date();
const end = new Date(today);
end.setDate(end.getDate() - 1); // yesterday
const start = new Date(end);
start.setDate(start.getDate() - 6); // 7 days total

const startYMD = toYMD(start);
const endYMD = toYMD(end);

// ---- GA4 runner ----
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

// ---- 1) KPIs per day ----
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

  const map = {};
  for (const r of rows) {
    const d = r.dimensionValues[0].value; // YYYYMMDD
    map[d] = {
      date: d,
      totalUsers: r.metricValues[0].value || "0",
      newUsers: r.metricValues[1].value || "0",
      pageviews: r.metricValues[2].value || "0", // store as 'pageviews'
      sessions: r.metricValues[3].value || "0",
      bounceRate: r.metricValues[4].value || "0",
      averageSessionDuration: r.metricValues[5].value || "0",
      referrers: [],
      authors: [],
    };
  }
  return map; // keyed by date
}

// ---- 2) Referrers per day ----
async function fetchReferrersPerDay() {
  const rows = await runReport({
    dimensions: ["date", "sessionSource"],
    metrics: ["totalUsers"],
  });
  const map = new Map(); // date -> [{source, users}]
  for (const r of rows) {
    const d = r.dimensionValues[0].value;
    const source = r.dimensionValues[1].value || "(not set)";
    const users = r.metricValues[0].value || "0";
    if (!map.has(d)) map.set(d, []);
    map.get(d).push({ source, users });
  }
  for (const [d, arr] of map) {
    arr.sort((a, b) => (+b.users || 0) - (+a.users || 0));
    map.set(d, arr.slice(0, 5));
  }
  return map;
}

// ---- 3) Authors per day (try candidates) ----
async function fetchAuthorsPerDay() {
  for (const dim of AUTHOR_DIM_CANDIDATES) {
    try {
      const rows = await runReport({
        dimensions: ["date", dim],
        metrics: ["totalUsers", "views"],
      });

      // count non-empty author rows
      const nonEmpty = rows.filter(
        (r) => (r.dimensionValues?.[1]?.value || "").trim() !== ""
      );
      console.log(`Authors probe using "${dim}": ${nonEmpty.length} rows`);

      if (nonEmpty.length > 0) {
        const map = new Map(); // date -> [{author, users, views}]
        for (const r of nonEmpty) {
          const d = r.dimensionValues[0].value;
          const author = r.dimensionValues[1].value || "(not set)";
          const users = r.metricValues[0].value || "0";
          const views = r.metricValues[1].value || "0";
          if (!map.has(d)) map.set(d, []);
          map.get(d).push({ author, users, views });
        }
        for (const [d, arr] of map) {
          arr.sort((a, b) => (+b.users || 0) - (+a.users || 0)).reverse();
          map.set(d, arr.slice(0, 10));
        }
        return map;
      }
    } catch (e) {
      console.log(`Authors probe failed for "${dim}": ${e.message}`);
    }
  }
  // nothing worked
  return new Map();
}

// ---- main ----
(async () => {
  try {
    console.log(
      `GA4 pull (property=${PROPERTY_ID}) ${startYMD} → ${endYMD}`
    );

    const [kpis, refMap, authMap] = await Promise.all([
      fetchDailyKPIs(),
      fetchReferrersPerDay(),
      fetchAuthorsPerDay(),
    ]);

    // Merge and ensure keys exist
    for (
      let d = new Date(start);
      d <= end;
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
    ) {
      const key = yyyymmdd(d);
      if (!kpis[key]) {
        kpis[key] = {
          date: key,
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
      kpis[key].referrers = refMap.get(key) || [];
      kpis[key].authors = authMap.get(key) || [];
    }

    const rows = Object.values(kpis).sort((a, b) => a.date.localeCompare(b.date));

    const out = {
      updatedAt: new Date().toISOString(),
      range: { start: startYMD, end: endYMD },
      rows,
    };

    const outDir = path.join(process.cwd(), "data");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, "ga4.json"),
      JSON.stringify(out, null, 2)
    );
    console.log(`✅ Wrote data/ga4.json (rows=${rows.length})`);
  } catch (err) {
    console.error("❌ GA4 fetch failed:", err?.message || err);
    process.exit(1);
  }
})();
