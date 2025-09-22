import fs from 'fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import fetch from 'node-fetch';

const argv = yargs(hideBin(process.argv))
  .option('api', { type: 'string', demandOption: true, desc: 'Base API URL, e.g. https://api.washingtonexaminer.com' })
  .option('out', { type: 'string', demandOption: true })
  .option('sinceHours', { type: 'number', default: 24 })
  .option('path', { type: 'string', default: '/articles', desc: 'Endpoint path if different' })
  // OPTIONAL auth (only used if provided)
  .option('token', { type: 'string', demandOption: false })
  .option('headerName', { type: 'string', default: 'Authorization' })
  .option('headerScheme', { type: 'string', default: 'Bearer' })
  // OPTIONAL param names if your API differs
  .option('sinceParam', { type: 'string', default: 'since' })
  .option('fieldsParam', { type: 'string', default: 'fields' })
  .argv;

/**
 * Expected shape (adjust via flags if needed):
 *   GET {api}{path}?since=ISO&limit=100&page=1&fields=title,slug,publishedAt,tags,authors,section
 * Returns array or {items|results|data: []}.
 */

const FIELDS = 'title,slug,publishedAt,tags,authors,section';

function buildUrl(base, path, sinceISO, page, limit, sinceParam, fieldsParam) {
  const u = new URL(path, base);
  u.searchParams.set(sinceParam, sinceISO);
  u.searchParams.set('limit', String(limit));
  u.searchParams.set('page', String(page));
  u.searchParams.set(fieldsParam, FIELDS);
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

async function fetchAllSince() {
  const toISO = new Date().toISOString();
  const from = new Date(Date.now() - argv.sinceHours * 3600 * 1000);
  const fromISO = from.toISOString();

  const headers = { Accept: 'application/json' };
  if (argv.token) {
    // Only attach auth if provided
    headers[argv.headerName] = argv.headerScheme
      ? `${argv.headerScheme} ${argv.token}`
      : argv.token;
  }

  let page = 1;
  const all = [];
  const MAX_PAGES = 20;
  while (page <= MAX_PAGES) {
    const url = buildUrl(argv.api, argv.path, fromISO, page, 100, argv.sinceParam, argv.fieldsParam);
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`WEX HTTP ${res.status} ${res.statusText} for ${url}\n${txt.slice(0, 300)}`);
    }
    const data = await res.json();
    const items = Array.isArray(data) ? data : (data.items || data.results || data.data || []);
    if (!items.length) break;

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

    const total = (data.total || data.count || 0);
    const limit = (data.limit || 100);
    if (total && page * limit >= total) break;
    if (items.length < 100) break;
    page += 1;
  }

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

  return {
    updatedAt: new Date().toISOString(),
    fromISO,
    toISO,
    totalArticles: all.length,
    topics,
    sampleArticles: all.slice(0, 20).map(a => ({ title: a.title, publishedAt: a.publishedAt, section: a.section }))
  };
}

(async () => {
  try {
    const out = await fetchAllSince();
    fs.mkdirSync('data', { recursive: true });
    fs.writeFileSync(argv.out, JSON.stringify(out, null, 2));
    console.log(`Wrote ${argv.out} with ${out.totalArticles} articles and ${out.topics.length} tags`);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
