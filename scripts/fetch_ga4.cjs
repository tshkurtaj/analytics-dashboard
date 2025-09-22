/**
 * Fetch GA4:
 *  - Daily KPIs for the last 7 days (date, totalUsers, newUsers, pageviews, sessions)
 *  - Top referrers (users) for yesterday
 *  - Top authors (users, views) for yesterday via custom event param: customEvent:authors
 *
 * Writes: data/ga4.json
 *
 * Requires env:
 *   GA4_PROPERTY_ID
 *   GOOGLE_APPLICATION_CREDENTIALS (set by the workflow from sa.json)
 */

const fs = require('fs');
const path = require('path');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');

const PROPERTY_ID = process.env.GA4_PROPERTY_ID;
if (!PROPERTY_ID) {
  console.error('Missing GA4_PROPERTY_ID env');
  process.exit(1);
}

const client = new BetaAnalyticsDataClient();

function ymd(d) {
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
function yyyymmdd(d) {
  return ymd(d).replaceAll('-', '');
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function toInt(x) {
  if (x == null) return 0;
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

async function runReport(request) {
  const [resp] = await client.runReport({
    property: `properties/${PROPERTY_ID}`,
    ...request,
  });
  return resp;
}

async function fetchDailyKpis(startDate, endDate) {
  // Use screenPageViews to represent pageviews.
  const resp = await runReport({
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'date' }],
    metrics: [
      { name: 'totalUsers' },
      { name: 'newUsers' },
      { name: 'screenPageViews' },
      { name: 'sessions' },
    ],
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: 1000,
  });

  const rows = (resp.rows || []).map((r) => {
    const getVal = (idx) => r.metricValues?.[idx]?.value ?? '0';
    return {
      date: r.dimensionValues?.[0]?.value ?? '',
      totalUsers: toInt(getVal(0)),
      newUsers: toInt(getVal(1)),
      pageviews: toInt(getVal(2)),
      sessions: toInt(getVal(3)),
    };
  });

  return rows;
}

async function fetchTopReferrers(forDate, limit = 10) {
  const resp = await runReport({
    dateRanges: [{ startDate: forDate, endDate: forDate }],
    dimensions: [{ name: 'sessionSource' }],
    metrics: [{ name: 'totalUsers' }],
    orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }],
    limit,
  });

  return (resp.rows || []).map((r) => ({
    source: r.dimensionValues?.[0]?.value ?? '',
    users: toInt(r.metricValues?.[0]?.value),
  }));
}

async function fetchTopAuthors(forDate, limit = 50) {
  // Your GA4 custom event param (event-scoped)
  const AUTHOR_DIM = 'customEvent:authors';

  const resp = await runReport({
    dateRanges: [{ startDate: forDate, endDate: forDate }],
    dimensions: [{ name: AUTHOR_DIM }],
    metrics: [
      { name: 'totalUsers' },
      { name: 'screenPageViews' }, // we output as "views"
    ],
    dimensionFilter: {
      filter: {
        fieldName: AUTHOR_DIM,
        stringFilter: { value: '(not set)', matchType: 'EXACT', caseSensitive: false },
        notExpression: true, // exclude "(not set)"
      },
    },
    orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }],
    limit,
  });

  return (resp.rows || []).map((r) => ({
    author: r.dimensionValues?.[0]?.value ?? '',
    users: toInt(r.metricValues?.[0]?.value),
    views: toInt(r.metricValues?.[1]?.value),
  }));
}

async function main() {
  const now = new Date();
  const yesterday = addDays(now, -1);
  const start = addDays(yesterday, -6);

  const startStr = ymd(start);
  const endStr = ymd(yesterday);

  console.log(`Building GA4 JSON for ${startStr} → ${endStr}`);

  // 1) Daily KPIs
  const kpiRows = await fetchDailyKpis(startStr, endStr);

  // 2) Authors & Referrers for yesterday only (attach to the last row)
  let authors = [];
  let referrers = [];
  try {
    authors = await fetchTopAuthors(endStr, 50);
  } catch (e) {
    console.warn('Authors query failed:', e?.message || e);
  }
  try {
    referrers = await fetchTopReferrers(endStr, 15);
  } catch (e) {
    console.warn('Referrers query failed:', e?.message || e);
  }

  if (kpiRows.length) {
    // convert all date strings to yyyymmdd for consistency with your site
    kpiRows.forEach(r => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
        r.date = r.date.replaceAll('-', '');
      }
    });

    kpiRows[kpiRows.length - 1].authors = authors;
    kpiRows[kpiRows.length - 1].referrers = referrers;
  }

  const out = {
    updatedAt: new Date().toISOString(),
    range: { start: startStr, end: endStr },
    rows: kpiRows,
  };

  const outPath = path.join(process.cwd(), 'data', 'ga4.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Wrote ${outPath} (rows=${kpiRows.length})`);
  console.log(`Authors probe (yesterday): ${authors.length} rows`);
  console.log(`Referrers probe (yesterday): ${referrers.length} rows`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
