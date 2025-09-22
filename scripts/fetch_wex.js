import fs from 'fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import fetch from 'node-fetch';

const argv = yargs(hideBin(process.argv))
  .option('api', { type: 'string', demandOption: true, desc: 'Base API URL, e.g. https://api.washingtonexaminer.com' })
  .option('out', { type: 'string', demandOption: true })
  .option('sinceHours', { type: 'number', default: 24 })
  .option('path', { type: 'string', default: '/articles', desc: 'Endpoint path' })

  // Param names (tweakable without code changes)
  .option('sinceParam', { type: 'string', default: 'since' })          // e.g. since | from | published_after
  .option('pageParam',  { type: 'string', default: 'page' })           // e.g. page | offset
  .option('limitParam', { type: 'string', default: 'limit' })          // e.g. limit | per_page | page_size
  .option('fieldsParam',{ type: 'string', default: 'fields' })         // if unsupported, pass empty string via --fieldsParam ""

  // Where are items in the response?
  .option('itemsKey',   { type: 'string', default: '', desc: 'If response is an object, the key holding the array (e.g. items, results, data). Leave empty if API returns an array directly.' })

  // Optional auth (if you later need it)
  .option('token',      { type: 'string', demandOption: false })
  .option('headerName', { type: 'string', default: 'Authorization' })
  .option('headerScheme',{ type: 'string', default: 'Bearer' })

  // Debug
  .option('debug',      { type: 'boolean', default: false })
  .option('maxPages',   { type: 'number', default: 20 })
  .argv;

const FIELDS = 'title,slug,publishedAt,tags,authors,section';

function buildUrl(base, path, { sinceISO, page, limit, sinceParam, pageParam, limitParam, fieldsParam }) {
  const u = new URL(path, base);
  u.searchParams.set(sinceParam, sinceISO);
  if (pageParam)  u.searchParams.set(pageParam, String(page));
  if (limitParam) u.searchParams.set(limitParam, String(limit));
  if (fieldsParam) u.searchParams.set(fieldsParam, FIELDS);
  return u.toString();
}

function normalizeTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map(t => String(t).trim()).filter(Boolean);
  return String(tags).split(',').map(t => t.trim()).filter(Boolean);
}
function normalizeAuthors(authors) {
  if (!authors) return [];
  if (Array.isArray(authors)) return authors.map(a => (a?.name ?? a).toString());
  return String(authors).split(',').map(a => a.trim()).filter(Boolean);
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, statusText: res.statusText, text, json };
}

async function main() {
  const toISO = new Date().toISOString();
  const fromISO = new Date(Date.now() - argv.sinceHours * 3600 * 1000).toISOString();

  const headers = { Accept: 'application/json' };
  if (argv.token) {
    headers[argv.headerName] = argv.headerScheme ? `${argv.headerScheme} ${argv.token}` : argv.token;
  }

  const conf = {
    sinceISO: fromISO,
    page: 1,
    limit: 100,
    sinceParam: argv.sinceParam,
    pageParam: argv.pageParam || '',
    limitParam: argv.limitParam || '',
    fieldsParam: argv.fieldsParam
  };

  const all = [];
  let page = 1;

  while (page <= argv.maxPages) {
    conf.page = page;
    const url = buildUrl(argv.api, argv.path, conf);

    // DEBUG: print the URL and first part of the response
    if (argv.debug) {
      console.log('[WEX DEBUG] URL:', url);
    }

    const { ok, status, statusText, text, json } = await fetchJson(url, headers);
    if (!ok) {
      console.error(`[WEX ERROR] HTTP ${status} ${statusText}`);
      if (argv.debug) console.error('[WEX DEBUG] Body head:', text.slice(0, 600));
      break;
    }
    if (argv.debug) {
      const head = text.slice(0, 600).replace(/\n/g, ' ');
      console.log('[WEX DEBUG] Response head:', head);
    }

    let items = [];
    if (Array.isArray(json)) {
      items = json;
    } else if (json && argv.itemsKey && Array.isArray(json[argv.itemsKey])) {
      items = json[argv.itemsKey];
    } else if (json) {
      // Try common keys if itemsKey not provided
      const guess = json.items || json.results || json.data;
      if (Array.isArray(guess)) items = guess;
    }

    if (!items.length) {
      if (argv.debug) console.log('[WEX DEBUG] No items on this page; stopping.');
      break;
    }

    for (const it of items) {
      const tags = normalizeTags(it.tags);
      all.push({
        title: it.title || it.headline || '',
        slug: it.slug || it.id || '',
        publishedAt: it.publishedAt || it.published_at || it.date || '',
        section: it.section || it.channel || '',
        authors: normalizeAuthors(it.authors),
        tags
      });
    }

    // pagination heuristics
    if (items.length < conf.limit) break;
    page += 1;
  }

  // Build topics aggregation
  const byTag = new Map();
  for (const a of all) {
    for (const t of a.tags) {
      const key = String(t).trim();
      const obj = byTag.get(key) || { name: key, count: 0, sampleTitles: new Set(), sections: new Set() };
      obj.count += 1;
      if (obj.sampleTitles.size < 3 && a.title) obj.sampleTitles.add(a.title);
      if (a.section) obj.sections.add(a.section);
      byTag.set(key, obj);
    }
  }

  const topics = Array.from(byTag.values())
    .map(v => ({
      name: v.name,
      count: v.count,
      sampleTitles: Array.from(v.sampleTitles),
      sections: Array.from(v.sections)
    }))
    .sort((a, b) => b.count - a.count);

  const out = {
    updatedAt: new Date().toISOString(),
    fromISO,
    toISO,
    totalArticles: all.length,
    topics,
    sampleArticles: all.slice(0, 10).map(a => ({ title: a.title, publishedAt: a.publishedAt, section: a.section }))
  };

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(argv.out, JSON.stringify(out, null, 2));
  console.log(`Wrote ${argv.out} (articles=${out.totalArticles}, topics=${out.topics.length})`);
}

main().catch(err => { console.error(err); process.exit(1); });
