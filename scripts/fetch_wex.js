import fs from 'fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import fetch from 'node-fetch';

const argv = yargs(hideBin(process.argv))
  .option('api', { type: 'string', demandOption: true, desc: 'Base API URL, e.g. https://api.washingtonexaminer.com' })
  .option('token', { type: 'string', demandOption: true, desc: 'Bearer token' })
  .option('out', { type: 'string', demandOption: true })
  .option('sinceHours', { type: 'number', default: 24 })
  .option('path', { type: 'string', default: '/articles', desc: 'Endpoint path if different' })
  .argv;

/**
 * This script assumes an endpoint like:
 *   GET {api}{path}?since=ISO&limit=100&page=1&fields=title,slug,publishedAt,tags,authors,section
 * …and Authorization: Bearer <token>
 *
 * If your API uses different param names or headers, tweak buildUrl() or headers below.
 */

const FIELDS = 'title,slug,publishedAt,tags,authors,section';

function buildUrl(base, path, sinceISO, page, limit = 100) {
  const u = new URL(path, base);
  u.searchParams.set('since', sinceISO);
  u.searchParams.set('limit', String(limit));
  u.searchParams.set('page', String(page));
  u.searchParams.set('fields', FIELDS);
  return u.toString();
}

function normalizeTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map(t => String(t).trim()).filter(Boolean);
  // comma-separated string fallback
  return String(tags).split(',').map(t => t.trim()).filter(Boolean);
}

function normalizeAuthors(authors) {
  if (!authors) return [];
  if (Array.isArray(authors)) return authors.map(a => (a.name || a).toString());
  return String(authors).split(',').map(a => a.trim()).filter(Boolean);
}

async function fetchAllSince() {
  const toISO = new Date().toISOString();
  const from = new Date(Date.now() - argv.sinceHours * 3600 * 1000);
  const fromISO = from.toISOString();

  const headers = {
    'Authorization': `Bearer ${argv.token}`,
    'Accept': 'application/json'
    // If your API wants X-API-Key instead, replace the line above with:
    // 'X-API-Key': argv.token
  };

  let page = 1;
  const all = [];
  const MAX_PAGES = 20; // safety

  while (page <= MAX_PAGES) {
    const url = buildUrl(argv.api, argv.path, fromISO, page, 100);
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`WEX HTTP ${res.status} ${res.statusText}: ${txt.slice(0, 300)}`);
    }
    const data = await res.json();

    // Accept either {items: []} or array directly
    const items = Array.isArray(data) ? data : (data.items || data.results || data.data || []);
    if (items.length === 0) break;

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

    // stop if API indicates no more pages
    const total = (data.total || data.count || 0);
    const limit = (data.limit || 100);
    if (total && page * limit >= total) break;

    // if returned fewer than limit, assume last page
    if (items.length < 100) break;

    page += 1;
  }

  // Aggregate by tag
  const byTag = new Map();
  for (const a of all) {
    if (!a.tags.length) continue;
    for (const t of a.tags) {
      const key = t.toString().trim();
      if (!byTag.has(key)) byTag.set(key, { name: key, count: 0, sampleTitles: new Set(), sections: new Set() });
      const obj = byTag.get(key);
      obj.count += 1;
      if (obj.sampleTitles.size < 3 && a.title) obj.sampleTitles.add(a.title);
      if (a.section) obj.sections.add(a.section);
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
    // keep a very small article list for debug/spot checks (titles only)
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
