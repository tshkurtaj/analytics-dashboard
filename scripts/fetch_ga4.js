// scripts/fetch_ga4.js
// Build data/ga4.json with KPIs + authors + referrers per day
import fs from 'fs/promises';
import { readFileSync } from 'fs';
import fetch from 'node-fetch';
import { JWT } from 'google-auth-library';

const argv = Object.fromEntries(
  process.argv.slice(2).map(p => {
    const m = p.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [p.replace(/^--/, ''), true];
  })
);

const PROPERTY_ID = argv.property || process.env.GA4_PROPERTY_ID;
const SA_PATH     = argv.sa || './service-account.json';
const OUT_PATH    = argv.out || 'data/ga4.json';

// how many days of rows to keep (yesterday back)
const DAYS = Number(argv.days || 7);

// ---------- auth ----------
if (!PROPERTY_ID) {
  console.error('Missing --property GA4 property id');
  process.exit(1);
}
const sa = JSON.parse(readFileSync(SA_PATH, 'utf8'));
const jwt = new JWT({
  email: sa.client_email,
  key: sa.private_key,
  scopes: ['https://www.googleapis.com/auth/analytics.readonly']
});

async function runReport(body) {
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY_ID}:runReport`;
  const token = await jwt.getAccessToken();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GA4 API ${res.status}: ${text}`);
  }
  return res.json();
}

// ---------- date helpers ----------
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function yyyymmdd(ymdStr) {
  return ymdStr.replaceAll('-', '');
}

const today = new Date();
const end = new Date(today);
end.setDate(end.getDate() - 1);
const start = new Date(end);
start.setDate(start.getDate() - (DAYS - 1));

const startYMD = ymd(start);
const endYMD = ymd(end);

// ---------- reports ----------
async function fetchKPIs() {
  return runReport({
    dateRanges: [{ startDate: startYMD, endDate: endYMD }],
    dimensions: [{ name: 'date' }],
    metrics: [
      { name: 'totalUsers' },
      { name: 'newUsers' },
      { name: 'screenPageViews' },  // GA4 metric; we’ll expose as "pageviews"
      { name: 'sessions' },
      { name: 'bounceRate' },
      { name: 'averageSessionDuration' }
    ],
    keepEmptyRows: false
  });
}

async function fetchReferrers() {
  return runReport({
    dateRanges: [{ startDate: startYMD, endDate: endYMD }],
    dimensions: [{ name: 'date' }, { name: 'sessionSource' }],
    metrics: [{ name: 'totalUsers' }],
    orderBys: [
      { metric: { metricName: 'totalUsers' }, desc: true }
    ],
    limit: 5000
  });
}

// IMPORTANT: your custom dimension is event-scoped "authors" -> customEvent:authors
async function fetchAuthors() {
  return runReport({
    dateRanges: [{ startDate: startYMD, endDate: endYMD }],
    dimensions: [{ name: 'date' }, { name: 'customEvent:authors' }],
    metrics: [
      { name: 'totalUsers' },
      { name: 'screenPageViews' }
    ],
    orderBys: [
      { metric: { metricName: 'totalUsers' }, desc: true }
    ],
    limit: 50000
  });
}

// ---------- compose ----------
function asNumber(x) {
  const n = Number(x ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const r of arr) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

async function main() {
  console.log(`Fetching GA4 for ${startYMD} .. ${endYMD}`);

  const [kpis, refs, auth] = await Promise.all([
    fetchKPIs(),
    fetchReferrers(),
    fetchAuthors()
  ]);

  // KPI rows by date
  const kpiRows = (kpis.rows || []).map(r => {
    const d = r.dimensionValues?.[0]?.value || '';
    const m = (name) => r.metricValues?.find((_, i) => kpis.metricHeaders[i].name === name)?.value;
    return {
      date: d, // yyyymmdd
      totalUsers: asNumber(m('totalUsers')),
      newUsers: asNumber(m('newUsers')),
      pageviews: asNumber(m('screenPageViews')),
      sessions: asNumber(m('sessions')),
      bounceRate: asNumber(m('bounceRate')),                    // 0.x
      averageSessionDuration: asNumber(m('averageSessionDuration')) // seconds
    };
  });

  // Referrers grouped by date
  const refRows = refs.rows || [];
  const refGrouped = groupBy(refRows, r => r.dimensionValues?.[0]?.value || '');
  // Authors grouped by date
  const authRows = auth.rows || [];
  const authGrouped = groupBy(authRows, r => r.dimensionValues?.[0]?.value || '');

  const rows = kpiRows.map(base => {
    const d = base.date;

    // attach referrers
    const refForDay = (refGrouped.get(d) || []).map(r => {
      const source = r.dimensionValues?.[1]?.value || '(unknown)';
      const users  = asNumber(r.metricValues?.[0]?.value);
      return { source, users };
    }).sort((a,b) => b.users - a.users).slice(0, 10);

    // attach authors
    const authForDay = (authGrouped.get(d) || []).map(r => {
      const author = r.dimensionValues?.[1]?.value || '(unknown)';
      const users  = asNumber(r.metricValues?.[0]?.value);
      const views  = asNumber(r.metricValues?.[1]?.value); // screenPageViews
      return { author, users, views };
    }).sort((a,b) => b.users - a.users).slice(0, 20);

    return {
      date: d,
      totalUsers: base.totalUsers,
      newUsers: base.newUsers,
      pageviews: base.pageviews,
      sessions: base.sessions,
      bounceRate: base.bounceRate,
      averageSessionDuration: base.averageSessionDuration,
      referrers: refForDay,
      authors: authForDay
    };
  }).sort((a,b) => a.date.localeCompare(b.date));

  const out = {
    updatedAt: new Date().toISOString(),
    range: { start: startYMD, end: endYMD },
    rows
  };

  await fs.mkdir('data', { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT_PATH} with ${rows.length} day rows`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
