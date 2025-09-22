// scripts/fetch_wex.js
// Fetch recent posts from a WP site and build a simple topics list (tags)

import fs from 'fs/promises';
import fetch from 'node-fetch';

const argv = Object.fromEntries(
  process.argv.slice(2).map(p => {
    const m = p.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [p.replace(/^--/, ''), true];
  })
);

const BASE     = (argv.base || process.env.WEX_API_URL || '').replace(/\/+$/, '');
const OUT_PATH = argv.out || 'data/topics.json';

async function fetchJSON(u) {
  const r = await fetch(u, { headers: { 'User-Agent': 'wex-scraper/1.0' } });
  if (!r.ok) throw new Error(`${u} -> ${r.status}`);
  return r.json();
}

async function main() {
  let articles = [];
  let topics = [];

  try {
    if (!BASE) throw new Error('No base URL');

    // last 24h
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    // fetch recent posts with _embed to get tags
    const url = `${BASE}/wp-json/wp/v2/posts?per_page=50&_embed=1&after=${encodeURIComponent(since)}&_fields=id,date,title,_embedded`;
    const posts = await fetchJSON(url);

    articles = posts.map(p => ({
      id: p.id,
      date: p.date,
      title: (p.title?.rendered || '').replace(/<[^>]+>/g,'').trim()
    }));

    // collect tag names
    const counts = {};
    for (const p of posts) {
      const terms = p._embedded?.['wp:term'] || [];
      const tagArray = terms.flat().filter(t => t.taxonomy === 'post_tag');
      for (const t of tagArray) {
        const name = (t.name || '').trim();
        if (!name) continue;
        counts[name] = (counts[name] || 0) + 1;
      }
    }
    topics = Object.entries(counts)
      .sort((a,b) => b[1]-a[1])
      .slice(0,50)
      .map(([name,count]) => ({ name, count }));

  } catch (e) {
    console.error('[WEX] error:', e.message);
  }

  const out = {
    updatedAt: new Date().toISOString(),
    totalArticles: articles.length,
    topics,
    sampleArticles: articles.slice(0,10)
  };

  await fs.mkdir('data', { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT_PATH} (articles=${articles.length}, topics=${topics.length})`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
