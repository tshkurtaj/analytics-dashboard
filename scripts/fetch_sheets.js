import fs from 'fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { google } from 'googleapis';

const argv = yargs(hideBin(process.argv))
  .option('sheet', { type: 'string', demandOption: true })
  .option('range', { type: 'string', demandOption: true }) // <-- tab/range like `'Master - 2022'!A:Z`
  .option('out', { type: 'string', demandOption: true })
  .argv;

process.env.GOOGLE_APPLICATION_CREDENTIALS = new URL('./sa.json', import.meta.url).pathname;

async function main() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: argv.sheet,
    range: argv.range,
    majorDimension: 'ROWS'
  });

  const values = res.data.values || [];
  const header = values[0] || [];
  const data = values.slice(1).map(row =>
    Object.fromEntries(header.map((h, i) => [h, row[i] ?? ""]))
  );

  const out = {
    updatedAt: new Date().toISOString(),
    sheet: argv.sheet,
    range: argv.range,
    columns: header,
    rowCount: Math.max(values.length - 1, 0),
    data
  };

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(argv.out, JSON.stringify(out, null, 2));
  console.log('Wrote', argv.out);
}

main().catch(err => { console.error(err); process.exit(1); });
