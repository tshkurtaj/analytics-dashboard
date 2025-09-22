import fs from 'fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import fetch from 'node-fetch';

const argv = yargs(hideBin(process.argv))
  .option('api', { type: 'string', demandOption: true })                  // e.g. https://washingtonexaminer.com
  .option('out', { type: 'string', demandOption: true })                  // e.g. data/topics.json
  .option('sinceHours', { type: 'number', default: 24 })
  .option('path', { type: 'string', default: '/wp-json/wp/v2/posts' })    // WP posts
  .option('pageParam',  { type: 'string', default: 'page' })
  .option('limitParam', { type: 'string', default: 'per_page' })
  .option('embed',      { type: 'boolean', default: true })
  .option('maxPages',   { type: 'number', default: 5 })
  .option('debug',      { type: 'boolean', default: true })
  .argv;

function buildUrl(base, path, { page, limit, afterISO, embed }) {
  const u = new URL(path, base);
  if (afterISO) u.searchParams.set('after', afterISO);      // WP expects RFC3339
  if (argv.pageParam)  u.searchParams.set(argv.pageParam, String(page));
  if (argv.limitParam) u.searchParams.set(argv.limitParam, String(limit));
  if (embed) u.searchParams.set('_embed', '1');
  u.searchParams.set('orderby', 'date');
  u.searchParams.set('order', 'desc');
  return u.toString();
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'wex-analytics-dashboard/1.0 (+https://github.com/tshkurtaj/analytics-dashboard)'
    }
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, statusText: res.statusText, json, text };
}

function extractTerms(item) {
  const groups = item?._embedded?.['wp:term'] || [];
  const names = [];
  for (const g of groups) {
    for (const t of g || []) {
      if ((t?.taxonomy === 'post_tag' || t?.taxonomy === 'category') && t?.name) {
        names.push(String(t.name));
      }
    }
  }
  return names;
}

function normalizeAuthors(item) {
  const authors = (item?._embedded?.author || []).map(a => a?.name).filter(Boolean);
  return authors.length ? authors : (item?.author ? [String(item.author)] : []);
}

function aggregateTopics(articles) {
  const by = new Map();
  for (const a of articles) {
    for (const n of a.tags) {
      const k = n.trim();
      if (!k) continue;
      const cur = by.get(k) || { name: k, count: 0, sampleTitles: new Set() };
      cur.count += 1;
      if (cur.sampleTitles.size < 3 && a.title) cur.sampleTitles.add(a.title);
      by.set(k, cur);
    }
  }
  return Array.from(by.values())
    .map(v => ({ name: v.name, count: v.count, sampleTitles: Array.from(v.sampleTitles) }))
    .sort((a, b) => b.count - a.count);
}

async function fetchPosts({ base, afterISO, maxPages, limit }) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = buildUrl(base, argv.path, { page, limit, afterISO, embed: argv.embed });
    if (argv.debug) console.log('[WEX DEBUG] URL:', url);
    const { ok, status, statusText, json, text } = await getJson(url);
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
      all.push({
        title: it?.title?.rendered ?? it?.title ?? '',
        slug: it?.slug ?? String(it?.id ?? ''),
        publishedAt: it?.date ?? it?.date_gmt ?? '',
        authors: normalizeAuthors(it),
        tags: extractTerms(it)   // tags + categories
      });
    }
    if (json.length < limit) break;
  }
  return all;
}

async function main() {
  const toISO = new Date().toISOString();
  const afterISO = new Date(Date.now() - argv.sinceHours * 3600 * 1000).toISOString();
  const base = argv.api.replace(/\/+$/, '');

  let articles = await fetchPosts({ base, afterISO, maxPages: argv.maxPages, limit: 100 });

  // Fallback if the 24h filter yields nothing: pull latest without "after"
  if (articles.length === 0) {
    if (argv.debug) console.log('[WEX DEBUG] Fallback: no posts in 24h, fetching latest without "after"');
    articles = await fetchPosts({ base, afterISO: null, maxPages: 2, limit: 50 });
  }

  const out = {
    updatedAt: new Date().toISOString(),
    fromISO: afterISO,
    toISO,
    totalArticles: articles.length,
    topics: aggregateTopics(articles),
    sampleArticles: articles.slice(0, 10).map(a => ({ title: a.title, publishedAt: a.publishedAt }))
  };

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(argv.out, JSON.stringify(out, null, 2));
  console.log(`Wrote ${argv.out} (articles=${out.totalArticles}, topics=${out.topics.length})`);
}

main().catch(err => { console.error(err); process.exit(1); });
