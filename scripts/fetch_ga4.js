// scripts/fetch_ga4.js
// Pulls daily GA4 metrics + yesterday's top referrers + authors (custom dimension)
// Writes GitHub Pages-friendly JSON to data/ga4.json

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BetaAnalyticsDataClient } from "@google-analytics/data";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  // -------- Settings from env --------
  const PROPERTY_ID = process.env.GA4_PROPERTY_ID; // e.g. 123456789
  if (!PROPERTY_ID) throw new Error("Missing GA4_PROPERTY_ID env var.");

  // If Actions passed the service account JSON as base64, decode and use it
  if (process.env.GCP_SA_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const saPath = path.join(__dirname, "..", "sa.json");
    const decoded = Buffer.from(process.env.GCP_SA_JSON, "base64").toString("utf8");
    await fs.writeFile(saPath, decoded, "utf8");
    process.env.GOOGLE_APPLICATION_CREDENTIALS = saPath;
  }

  // Custom-dimension API name for authors
  // GA4 UI shows "authors" as the friendly name, but the *API* name is usually "customEvent:authors"
  // If your property uses a different API name, set GA4_AUTHORS_DIM in the workflow env.
  const AUTHORS_DIM = process.env.GA4_AUTHORS_DIM || "customEvent:authors";

  // How many days of daily rows to keep in the output
  const DAYS = parseInt(process.env.GA4_DAYS || "7", 10);

  const client = new BetaAnalyticsDataClient();

  const todayUTC = new Date();
  // "Yesterday" in UTC so we don't spill into a partially-complete day
  const end = ymd(addDays(todayUTC, -1));
  const start = ymd(addDays(todayUTC, -DAYS));

  const property = `properties/${PROPERTY_ID}`;

  // -------- 1) Daily metrics rows (date + sitewide metrics) --------
  const dailyRes = await client.runReport({
    property,
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [{ name: "date" }],
    metrics: [
      { name: "totalUsers" },
      { name: "newUsers" },
      { name: "screenPageViews" }, // we'll map to "pageviews"
      { name: "sessions" },
      { name: "bounceRate" },
      { name: "averageSessionDuration" },
    ],
    orderBys: [{ dimension: { dimensionName: "date" } }],
    limit: 1000,
  });

  const rows = (dailyRes[0]?.rows || []).map((r) => {
    const d = val(r, 0); // yyyyMMdd
    const totalUsers = num(r, 1);
    const newUsers = num(r, 2);
    const screenPageViews = num(r, 3);
    const sessions = num(r, 4);
    const bounceRate = num(r, 5); // 0..1 decimal from API
    const avgSession = num(r, 6); // seconds
    return {
      date: d,
      totalUsers: String(totalUsers),
      newUsers: String(newUsers),
      pageviews: String(screenPageViews), // rename in output
      sessions: String(sessions),
      bounceRate: String(bounceRate),
      averageSessionDuration: String(avgSession),
    };
  });

  // If there are no rows, still write a stub to avoid breaking the site
  if (!rows.length) {
    await writeOut({ updatedAt: new Date().toISOString(), range: { start, end }, rows: [] });
    console.log("No GA4 rows returned. Wrote empty data/ga4.json");
    return;
  }

  // -------- 2) Yesterday's top referrers (source) --------
  const yestYMD = end.replaceAll("-", ""); // match daily rows key
  const refRes = await client
    .runReport({
      property,
      dateRanges: [{ startDate: end, endDate: end }],
      dimensions: [{ name: "source" }],
      metrics: [{ name: "totalUsers" }],
      orderBys: [{ metric: { metricName: "totalUsers" }, desc: true }],
      limit: 25,
    })
    .catch(() => [null]);

  const referrers = (refRes[0]?.rows || []).map((r) => ({
    source: val(r, 0),
    users: String(num(r, 1)),
  }));

  // -------- 3) Yesterday's top authors (custom dimension) --------
  const authRes = await client
    .runReport({
      property,
      dateRanges: [{ startDate: end, endDate: end }],
      dimensions: [{ name: AUTHORS_DIM }],
      metrics: [
        { name: "totalUsers" },
        { name: "screenPageViews" }, // map to "views" in output
      ],
      orderBys: [{ metric: { metricName: "totalUsers" }, desc: true }],
      limit: 100,
    })
    .catch((err) => {
      console.warn(
        `Author report failed (dim=${AUTHORS_DIM}). Set GA4_AUTHORS_DIM if needed.`,
        err?.message || err
      );
      return [null];
    });

  const authors = (authRes[0]?.rows || [])
    .map((r) => ({
      author: val(r, 0) || "(not set)",
      users: String(num(r, 1)),
      views: String(num(r, 2)),
    }))
    .filter((a) => a.author && a.author !== "(not set)");

  // Attach the referrers/authors to the "yesterday" row
  const last = rows.find((r) => r.date === yestYMD);
  if (last) {
    last.referrers = referrers;
    last.authors = authors;
  }

  const out = {
    updatedAt: new Date().toISOString(),
    range: { start, end },
    rows,
  };

  await writeOut(out);

  console.log(
    `Wrote data/ga4.json — ${rows.length} daily rows, ${referrers.length} referrers, ${authors.length} authors (yesterday=${end})`
  );
}

// ---------- helpers ----------
function ymd(d) {
  // returns YYYY-MM-DD
  const dt = new Date(d);
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

function addDays(d, n) {
  const dt = new Date(d);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt;
}

function val(row, idx) {
  return row?.dimensionValues?.[idx]?.value || row?.metricValues?.[idx]?.value || "";
}
function num(row, idx) {
  const v = row?.metricValues?.[idx]?.value ?? row?.dimensionValues?.[idx]?.value ?? "0";
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function writeOut(json) {
  const outDir = path.join(__dirname, "..", "data");
  const outFile = path.join(outDir, "ga4.json");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(json, null, 2), "utf8");
}

// ---------- run ----------
main().catch((err) => {
  console.error("GA4 fetch failed:", err?.message || err);
  process.exit(1);
});

