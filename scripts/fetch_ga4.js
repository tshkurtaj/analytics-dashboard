#!/usr/bin/env node
/**
 * GA4 -> data/ga4.json (7 days)
 * For each day:
 *   KPIs (users, newUsers, sessions, pageviews, bounceRate, avgSessionDuration)
 *   + referrers [{source, users}]
 *   + authors   [{author, users, views}]         // if GA4_AUTHOR_DIMENSION provided
 *   + sections  [{section, users, views}]        // if GA4_SECTION_DIMENSION provided
 *
 * ENV:
 *   GA4_PROPERTY_ID
 *   GCP_SA_JSON                // base64 of service account JSON
 *   GA4_AUTHOR_DIMENSION       // e.g. customEvent:author (from GA4 UI "API name")
 *   GA4_SECTION_DIMENSION      // e.g. customEvent:section
 */

const fs = require('fs/promises');
const path = require('path');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');

(async function main() {
  try {
    const PROPERTY_ID = process.env.GA4_PROPERTY_ID;
    const SA_B64      = process.env.GCP_SA_JSON;
    const DIM_AUTHOR  = process.env.GA4_AUTHOR_DIMENSION || '';   // e.g. customEvent:author
    const DIM_SECTION = process.env.GA4_SECTION_DIMENSION || '';  // e.g. customEvent:section

    if (!PROPERTY_ID) { console.error('Missing GA4_PROPERTY_ID'); process.exit(1); }
    if (!SA_B64)      { console.error('Missing GCP_SA_JSON (base64)'); process.exit(1); }

    // Auth
    const credentials = JSON.parse(Buffer.from(SA_B64, 'base64').toString('utf8'));
    const client = new BetaAnalyticsDataClient({ credentials });

    // Date helpers (UTC)
    const truncUTC = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const todayUTC = truncUTC(new Date());
    const endDate  = new Date(todayUTC); endDate.setUTCDate(endDate.getUTCDate() - 1); // yesterday
    const startDate= new Date(endDate);  startDate.setUTCDate(startDate.getUTCDate() - 6); // last 7 days

    const iso = (d) => d.toISOString().slice(0,10);
    const yyyymmdd = (d) => iso(d).replace(/-/g, '');
    const eachDay = (d0, d1) => {
      const out = [];
      const d = new Date(d0);
      while (d <= d1) { out.push(new Date(d)); d.setUTCDate(d.getUTCDate() + 1); }
      return out;
    };

    const startISO = iso(startDate);
    const endISO   = iso(endDate);

    // --- 1) KPIs over range by date
    const [kpiResp] = await client.runReport({
      property: `properties/${PROPERTY_ID}`,
      dateRanges: [{ startDate: startISO, endDate: endISO }],
      dimensions: [{ name: 'date' }],
      metrics: [
        { name: 'totalUsers' },
        { name: 'newUsers' },
        { name: 'sessions' },
        { name: 'screenPageViews' },
        { name: 'bounceRate' },
        { name: 'averageSessionDuration' }
      ],
      orderBys: [{ dimension: { dimensionName: 'date' } }]
    });

    const rowsByDate = Object.create(null);
    for (const r of (kpiResp.rows || [])) {
      const d  = r.dimensionValues?.[0]?.value || '';
      const mv = r.metricValues || [];
      rowsByDate[d] = {
        date: d,
        totalUsers:               Number(mv[0]?.value || 0),
        newUsers:                 Number(mv[1]?.value || 0),
        sessions:                 Number(mv[2]?.value || 0),
        pageviews:                Number(mv[3]?.value || 0),
        bounceRate:               Number(mv[4]?.value || 0),   // 0..1
        averageSessionDuration:   Number(mv[5]?.value || 0)    // seconds
      };
    }

    // Helpers to fetch daily breakdowns
    async function fetchReferrers(dayISO) {
      const [resp] = await client.runReport({
        property: `properties/${PROPERTY_ID}`,
        dateRanges: [{ startDate: dayISO, endDate: dayISO }],
        dimensions: [{ name: 'sessionSource' }],
        metrics: [{ name: 'totalUsers' }],
        orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }],
        limit: 50
      });
      return (resp.rows || []).map(r => ({
        source: r.dimensionValues?.[0]?.value || '',
        users:  Number(r.metricValues?.[0]?.value || 0)
      })).filter(x => x.source);
    }

    async function fetchDim(dayISO, dimName) {
      if (!dimName) return [];
      const [resp] = await client.runReport({
        property: `properties/${PROPERTY_ID}`,
        dateRanges: [{ startDate: dayISO, endDate: dayISO }],
        dimensions: [{ name: dimName }],
        metrics: [{ name: 'totalUsers' }, { name: 'screenPageViews' }],
        orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }],
        limit: 100
      });
      return (resp.rows || []).map(r => ({
        key:   r.dimensionValues?.[0]?.value || '',
        users: Number(r.metricValues?.[0]?.value || 0),
        views: Number(r.metricValues?.[1]?.value || 0)
      })).filter(x => x.key);
    }

    // --- 2) For each day, attach referrers/authors/sections
    for (const d of eachDay(startDate, endDate)) {
      const dayISO = iso(d);
      const dayKey = yyyymmdd(d);
      if (!rowsByDate[dayKey]) {
        // Fill with zeros if KPI row missing (rare)
        rowsByDate[dayKey] = {
          date: dayKey, totalUsers:0,newUsers:0,sessions:0,pageviews:0,bounceRate:0,averageSessionDuration:0
        };
      }

      try {
        const refs = await fetchReferrers(dayISO);
        rowsByDate[dayKey].referrers = refs.slice(0, 25);
      } catch (e) {
        console.warn(`Referrers failed for ${dayISO}:`, e.message);
      }

      if (DIM_AUTHOR) {
        try {
          const a = await fetchDim(dayISO, DIM_AUTHOR);
          rowsByDate[dayKey].authors = a.slice(0, 50).map(x => ({ author: x.key, users: x.users, views: x.views }));
        } catch (e) {
          console.warn(`Authors failed for ${dayISO}:`, e.message);
        }
      }

      if (DIM_SECTION) {
        try {
          const s = await fetchDim(dayISO, DIM_SECTION);
          rowsByDate[dayKey].sections = s.slice(0, 50).map(x => ({ section: x.key, users: x.users, views: x.views }));
        } catch (e) {
          console.warn(`Sections failed for ${dayISO}:`, e.message);
        }
      }
    }

    // Sort rows by date ascending
    const rows = Object.values(rowsByDate).sort((a,b) => a.date.localeCompare(b.date));

    // Write file
    const out = {
      updatedAt: new Date().toISOString(),
      range: { start: startISO, end: endISO },
      rows
    };
    await fs.mkdir(path.join(process.cwd(), 'data'), { recursive: true });
    await fs.writeFile(path.join(process.cwd(), 'data', 'ga4.json'), JSON.stringify(out, null, 2));
    console.log(`Wrote data/ga4.json with ${rows.length} day rows (each with KPIs + breakdowns).`);
  } catch (err) {
    console.error('GA4 fetch failed:', err);
    process.exit(1);
  }
})();
