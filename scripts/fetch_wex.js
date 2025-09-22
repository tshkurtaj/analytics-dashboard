import fs from 'fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import fetch from 'node-fetch';

const argv = yargs(hideBin(process.argv))
  .option('api', { type: 'string', demandOption: true })                 // e.g. https://www.washingtonexaminer.com
  .option('out', { type: 'string', demandOption: true })                // e.g. data/topics.json
  .option('sinceHours', { type: 'number', default: 24 })
  .option('path', { type: 'string', default: '/wp-json/wp/v2/posts' })  // WP posts endpoint
  .option('sinceParam', { type: 'string', default: 'after' })           // WP uses ?after=ISO8601
  .option('pageParam',  { type: 'string', default: 'page' })
  .option('limitParam', { type: 'string', default: 'per_page' })
  .option('itemsKey',   { type: 'string', default: '' })                // WP returns an array; leave empty
  .option('embed',      { type: 'boolean', default: true })             // add &_embed=1 to get tag names
  .option('debug',      { type: 'boolean', default: false })
  .option('maxPages',   { type: 'number', default: 5 })
  .argv;

function buildUrl(base, path, { sinceISO, page, limit, sinceParam, pageParam, limitParam, embed }) {
  const u = new URL(path, base);
  u.searchParams.set(sinceParam, sinceISO);
  if (pageParam)  u.searchParams.set(pageParam, String(page));
  if (limitParam) u.searchParams.set(limitParam, String(limit));
  if (embed)      u.searchParams.set('_embed', '1');  // expand authors, terms
  u.searchParams.set('orderby', 'date');
  u.searchParams.set('order', 'desc');
  return u.toString();
}

function normalizeAuthors(authors) {
  if (!authors) return [];
  if (Array.isArray(authors)) return authors.map(a => (a?.name ?? a).toString());
  return [String(authors)];
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

  const headers = { Accept: 'application/json' }; // WP is public; no auth

  const conf = {
    sinceISO: fromISO,
    page: 1,
    limit: 100,
    sinceParam: argv.sinceParam,
    pageParam: argv.pageParam,
    limitParam: argv.limitParam,
    embed: argv.embed
  };

  const all = [];
  let page = 1;

  while (page <= argv.maxPages) {
    conf.page = page;
    const url = buildUrl(argv.api, argv.path, conf);
    if (argv.debug) console.log('[WEX DEBUG] URL:', url);

    const { ok, status, statusText, text, json } = await fetchJson(url, headers);
    if (!ok) {
      console.error(`[WEX ERROR] HTTP ${status} ${statusText}`);
      if (argv.debug) console.error('[WEX DEBUG] Body head:', text.slice(0, 400));
      break;
    }

    if (!Array.isArray(json)) {
      if (argv.debug) console.error('[WEX DEBUG] Expected array, got:', typeof json);
      break;
    }
    if (argv.debug) console.log('[WEX DEBUG] Items:', json.length);

    for (const it of json) {
      // Pull tag NAMES from _embedded terms
      const terms = it?._embedded?.['wp:term'] ?? [];
      const tagNames = [];
      for (const group of terms) {
        for (const term of group || []) {
          if (term?.taxonomy === 'post_tag' && term?.name) tagNames.push(term.name);
        }
      }

      // Author names (embedded)
      const authorNames = (it?._embedded?.author || [])
        .map(a => a?.name)
        .filter(Boolean);

      all.push({
        title: it?.title?.rendered ?? it?.title ?? '',
        slug: it?.slug ?? String(it?.id ?? ''),
        publishedAt: it?.date ?? it?.date_gmt ?? '',
        section: '', // WP posts don’t have a single "section" by default
        authors: normalizeAuthors(authorNames.length ? authorNames : it?.author),
        tags: tagNames.length ? tagNames : []
      });
    }

    if (json.length < conf.limit) break; // last page
    page += 1;
  }

  // Aggregate by tag
  const byTag = new Map();
  for (const a of all) {
    for (const t of a.tags) {
      const key = String(t).trim();
      if (!key) continue;
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
    sampleArticles: all.slice(0, 10).map(a => ({ title: a.title, publishedAt: a.publishedAt }))
  };

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(argv.out, JSON.stringify(out, null, 2));
  console.log(`Wrote ${argv.out} (articles=${out.totalArticles}, topics=${out.topics.length})`);
}

main().catch(err => { console.error(err); process.exit(1); });
