import fs from 'fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { google } from 'googleapis';

const argv = yargs(hideBin(process.argv))
  .option('sheet', { type: 'string', demandOption: true })
  .option('out', { type: 'string', demandOption: true })
  .argv;

// GitHub Action writes sa.json into /scripts
process.env.GOOGLE_APPLICATION_CREDENTIALS = new URL('./sa.json', import.meta.url).pathname;

async function main() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Adjust the range to your sheet/tab if needed
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: argv.sheet,
    range: 'Dashboard!A1:Z1000'
  });

  const rows = res.data.values || [];
  const header = rows[0] || [];
  const data = rows.slice(1).map(r =>
    Object.fromEntries(header.map((h, i) => [h, r[i]]))
  );

  const out = {
    updatedAt: new Date().toISOString(),
    sheet: argv.sheet,
    data
  };

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(argv.out, JSON.stringify(out, null, 2));
  console.log('Wrote', argv.out);
}

main().catch(err => { console.error(err); process.exit(1); });
