/* scripts/fetch_ga4.cjs */

const fs = require('fs');
const path = require('path');
const {BetaAnalyticsDataClient} = require('@google-analytics/data');

const propertyId = process.env.GA4_PROPERTY_ID;
if (!propertyId) {
  console.error('Missing GA4_PROPERTY_ID env var');
  process.exit(1);
}

const client = new BetaAnalyticsDataClient();

function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}`;
}
function ymdDashed(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

async function fetchKPIsLast7Days() {
  // One report grouped by date
  const [resp] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: '7daysAgo', endDate: 'yesterday' }],
    dimensions: [{ name: 'date' }],
    metrics: [
      { name: 'totalUsers' },
      { name: 'newUsers' },
      { name: 'screenPageViews' }, // we'll map to "pageviews"
      { name: 'sessions' },
      { name: 'bounceRate' },
      { name: 'averageSessionDuration' }
    ],
    orderBys: [{ dimension: { dimensionName: 'date' } }]
  });

  const rows = (resp.rows || []).map(r => {
    const d = r.dimensionValues?.[0]?.value || '';
    const m = r.metricValues || [];
    return {
      date: d,                                   // "YYYYMMDD"
      totalUsers: Number(m[0]?.value || 0),
      newUsers: Number(m[1]?.value || 0),
      pageviews: Number(m[2]?.value || 0),
      sessions: Number(m[3]?.value || 0),
      bounceRate: Number(m[4]?.value || 0),                 // 0..1 in GA UI shown as %
      averageSessionDuration: Number(m[5]?.value || 0)      // seconds
    };
  });

  return rows;
}

async function fetchTopReferrersFor(dateYMD) {
  // Use sessionSource for traffic sources; top by users
  const [resp] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: dateYMD, endDate: dateYMD }],
    dimensions: [{ name: 'sessionSource' }],
    metrics: [{ name: 'totalUsers' }],
    limit: 10,
    orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }]
  });

  const out = (resp.rows || []).map(r => ({
    source: r.dimensionValues?.[0]?.value || '(unknown)',
    users: Number(r.metricValues?.[0]?.value || 0)
  }));
  console.log(`[GA4] Referrers rows for ${dateYMD}: ${out.length}`);
  return out;
}

async function fetchTopAuthorsFor(dateYMD) {
  // YOUR custom dim is "authors" => API name is "customEvent:authors"
  const [resp] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: dateYMD, endDate: dateYMD }],
    dimensions: [{ name: 'customEvent:authors' }],
    metrics: [
      { name: 'totalUsers' },
      { name: 'screenPageViews' }
    ],
    limit: 10,
    orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }]
  });

  const out = (resp.rows || []).map(r => ({
    author: r.dimensionValues?.[0]?.value || '(not set)',
    users: Number(r.metricValues?.[0]?.value || 0),
    views: Number(r.metricValues?.[1]?.value || 0)
  }));
  console.log(`[GA4] Authors rows for ${dateYMD}: ${out.length}`);
  return out;
}

(async () => {
  try {
    const kpiRows = await fetchKPIsLast7Days();
    if (!kpiRows.length) throw new Error('No KPI rows returned');

    // Most recent day in the KPI set
    const lastYMD = kpiRows[kpiRows.length - 1].date;

    // Enrich the most recent day with referrers + authors
    const [referrers, authors] = await Promise.all([
      fetchTopReferrersFor(lastYMD),
      fetchTopAuthorsFor(lastYMD),
    ]);

    // Attach to the last object
    kpiRows[kpiRows.length - 1].referrers = referrers;
    kpiRows[kpiRows.length - 1].authors = authors;

    // Add range + updatedAt metadata
    const startDate = kpiRows[0].date;
    const endDate = lastYMD;
    const out = {
      updatedAt: new Date().toISOString(),
      range: {
        start: `${startDate.slice(0,4)}-${startDate.slice(4,6)}-${startDate.slice(6,8)}`,
        end:   `${endDate.slice(0,4)}-${endDate.slice(4,6)}-${endDate.slice(6,8)}`
      },
      rows: kpiRows
    };

    const outPath = path.join(process.cwd(), 'data', 'ga4.json');
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.log(`✔ Wrote ${outPath} (rows=${kpiRows.length})`);
  } catch (err) {
    console.error('GA4 build failed:', err?.message || err);
    process.exit(1);
  }
})();
