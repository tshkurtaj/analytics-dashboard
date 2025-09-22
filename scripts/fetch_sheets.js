// scripts/fetch_sheets.js
// Read a Google Sheet and write data/sheets.json
// Requires service-account auth with Sheets API scope.

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

const SHEETS_ID = argv.sheetsId || process.env.SHEETS_ID;
const RANGE     = argv.range     || process.env.SHEETS_RANGE || 'A:Z';
const SA_PATH   = argv.sa        || './service-account.json';
const OUT_PATH  = argv.out       || 'data/sheets.json';

if (!SHEETS_ID) {
  console.error('Missing --sheetsId or $SHEETS_ID');
  process.exit(1);
}

const sa = JSON.parse(readFileSync(SA_PATH, 'utf8'));
const jwt = new JWT({
  email: sa.client_email,
  key: sa.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
});

async function main() {
  const token = await jwt.getAccessToken();

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}/values/${encodeURIComponent(RANGE)}?majorDimension=ROWS`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token.token}` }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sheets API ${res.status}: ${text}`);
  }
  const json = await res.json();

  const values = json.values || [];
  const headers = (values[0] || []).map(h => String(h).trim());
  const rows = values.slice(1).map(r => {
    const row = {};
    headers.forEach((h, i) => row[h || `col${i+1}`] = r[i] ?? '');
    return row;
  });

  const out = {
    updatedAt: new Date().toISOString(),
    sheet: RANGE,
    rowCount: rows.length,
    data: rows
  };

  await fs.mkdir('data', { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT_PATH} (${rows.length} rows)`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
