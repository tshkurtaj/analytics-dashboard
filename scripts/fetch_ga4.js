import { BetaAnalyticsDataClient } from '@google-analytics/data';
import fs from 'fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option('property', { type: 'string', demandOption: true })
  .option('out', { type: 'string', demandOption: true })
  .argv;

// GitHub Action will write sa.json into /scripts
process.env.GOOGLE_APPLICATION_CREDENTIALS = new URL('./sa.json', import.meta.url).pathname;

const client = new BetaAnalyticsDataClient();

async function main() {
  const property = `properties/${argv.property}`;
  const now = Date.now();
  const yesterdayISO = new Date(now - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const sevenISO = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const [report] = await client.runReport({
    property,
    dateRanges: [{ startDate: sevenISO, endDate: yesterdayISO }],
    metrics: [
      { name: 'totalUsers' },
      { name: 'newUsers' },
      { name: 'screenPageViews' },
      { name: 'sessions' }
    ],
    dimensions: [{ name: 'date' }]
  });

  const rows = (report.rows || []).map(r => ({
    date: r.dimensionValues?.[0]?.value,
    totalUsers: Number(r.metricValues?.[0]?.value || 0),
    newUsers: Number(r.metricValues?.[1]?.value || 0),
    pageviews: Number(r.metricValues?.[2]?.value || 0),
    sessions: Number(r.metricValues?.[3]?.value || 0)
  }));

  const yesterday = rows[rows.length - 1] || null;
  const out = {
    updatedAt: new Date().toISOString(),
    range: { start: sevenISO, end: yesterdayISO },
    rows,
    yesterday
  };

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(argv.out, JSON.stringify(out, null, 2));
  console.log('Wrote', argv.out);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
