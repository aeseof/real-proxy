const https = require('https');
const http  = require('http');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function fetch(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-Mode': 'navigate',
        'Upgrade-Insecure-Requests': '1',
      }
    }, res => {
      // follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parseGoogle(html) {
  const results = [];
  // Match result blocks: each contains a link + title + description
  // Google's structure: <div class="g"> ... <a href="..."><h3>title</h3></a> ... snippet ...
  const blockRe = /<div[^>]+class="[^"]*\bg\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;

  // Simpler approach: extract all hrefs that look like real URLs paired with nearby text
  // Pattern: <a href="/url?q=REALURL&..."><h3>TITLE</h3></a>
  const linkRe  = /<a\s+href="\/url\?q=(https?[^&"]+)[^"]*"[^>]*>\s*<h3[^>]*>([^<]+)<\/h3>/g;
  const snippRe = /<div[^>]+class="[^"]*VwiC3b[^"]*"[^>]*>([\s\S]*?)<\/div>/g;

  const snippets = [];
  let sm;
  while ((sm = snippRe.exec(html)) !== null) {
    snippets.push(sm[1].replace(/<[^>]+>/g, '').trim());
  }

  let m, i = 0;
  while ((m = linkRe.exec(html)) !== null) {
    const url   = decodeURIComponent(m[1]);
    const title = m[2].replace(/<[^>]+>/g, '').trim();
    if (!url || !title) continue;
    if (url.includes('google.com')) continue;
    results.push({ title, url, desc: snippets[i] || '' });
    i++;
    if (results.length >= 10) break;
  }

  return results;
}

function parseBing(html) {
  const results = [];
  // Bing: <li class="b_algo"><h2><a href="URL">TITLE</a></h2>...<p>DESC</p>
  const blockRe = /<li[^>]+class="b_algo"[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const block = m[1];
    const linkM  = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/i.exec(block);
    const descM  = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    if (!linkM) continue;
    const url   = linkM[1];
    const title = linkM[2].trim();
    const desc  = descM ? descM[1].replace(/<[^>]+>/g,'').trim() : '';
    if (!url.startsWith('http')) continue;
    results.push({ title, url, desc });
    if (results.length >= 10) break;
  }
  return results;
}

function parseBritannica(html) {
  const results = [];
  // Britannica search: <a href="/topic/..."><span class="card-title">TITLE</span>
  const blockRe = /<a\s+href="(\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const href  = m[1];
    const inner = m[2];
    if (!href.startsWith('/topic') && !href.startsWith('/science') && !href.startsWith('/place') && !href.startsWith('/biography') && !href.startsWith('/event') && !href.startsWith('/art')) continue;
    const titleM = /<span[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)<\/span>/i.exec(inner) ||
                   /<h[23][^>]*>([^<]+)<\/h[23]>/i.exec(inner);
    if (!titleM) continue;
    const title = titleM[1].trim();
    if (!title || title.length < 3) continue;
    const descM = /<p[^>]*>([^<]{20,})<\/p>/i.exec(inner);
    results.push({
      title,
      url: 'https://www.britannica.com' + href,
      desc: descM ? descM[1].trim() : ''
    });
    if (results.length >= 10) break;
  }
  return results;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const { q, engine = 'google', page = '1' } = event.queryStringParameters || {};
  if (!q) return { statusCode: 400, headers, body: JSON.stringify({ error: 'missing q' }) };

  const p   = parseInt(page) || 1;
  const off = (p - 1) * 10;

  let url;
  if (engine === 'google') {
    url = `https://www.google.com/search?q=${encodeURIComponent(q)}&start=${off}&num=10&hl=en&gl=us`;
  } else if (engine === 'bing') {
    url = `https://www.bing.com/search?q=${encodeURIComponent(q)}&first=${off + 1}`;
  } else if (engine === 'britannica') {
    url = `https://www.britannica.com/search?query=${encodeURIComponent(q)}&page=${p}`;
  } else {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'unknown engine' }) };
  }

  try {
    const { status, body } = await fetch(url);
    if (status !== 200) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: `upstream ${status}`, html_snippet: body.slice(0, 300) }) };
    }

    let results = [];
    if (engine === 'google')     results = parseGoogle(body);
    else if (engine === 'bing')  results = parseBing(body);
    else                         results = parseBritannica(body);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ results, page: p, engine, query: q }),
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
