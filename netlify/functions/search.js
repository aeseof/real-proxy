const https = require('https');

const SERPER_KEY    = process.env.SERPER_API_KEY    || '2aea0c082b9cee3d3f6397e6ad4f9a3c205ec1b7';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

// ── HTTP helper ──
function req(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const buf = body ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const r = https.request(url, { method, headers: { ...headers, ...(buf ? { 'Content-Length': buf.length } : {}) } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return req(method, res.headers.location, headers, body).then(resolve).catch(reject);
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    r.setTimeout(12000, () => { r.destroy(); reject(new Error('timeout')); });
    if (buf) r.write(buf);
    r.end();
  });
}

// ── Serper (primary) ──
async function serperSearch(q, engine, page) {
  const query = engine === 'britannica' ? `site:britannica.com ${q}` : q;
  const { status, body } = await req('POST', 'https://google.serper.dev/search',
    { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
    { q: query, page, num: 10 }
  );
  if (status !== 200) throw new Error(`serper ${status}`);
  const json = JSON.parse(body);
  if (json.statusCode === 403 || json.error) throw new Error(json.error || 'serper quota exceeded');
  return (json.organic || []).map(r => ({
    title: r.title || '', url: r.link || '', desc: r.snippet || '',
  })).filter(r => r.title && r.url);
}

// ── Fetch raw HTML ──
async function fetchHTML(url) {
  const { status, body } = await req('GET', url, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
  });
  if (status !== 200) throw new Error(`upstream ${status}`);
  return body;
}

// ── Claude backup ──
async function claudeSearch(q, engine, page) {
  if (!ANTHROPIC_KEY) throw new Error('no anthropic key configured');

  const urls = {
    google:     `https://www.google.com/search?q=${encodeURIComponent(q)}&start=${(page-1)*10}&num=10&hl=en`,
    bing:       `https://www.bing.com/search?q=${encodeURIComponent(q)}&first=${(page-1)*10+1}`,
    britannica: `https://www.britannica.com/search?query=${encodeURIComponent(q)}&page=${page}`,
  };

  const html = await fetchHTML(urls[engine] || urls.google);
  const trimmed = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                      .replace(/<style[\s\S]*?<\/style>/gi, '')
                      .replace(/<[^>]+>/g, ' ')
                      .replace(/\s+/g, ' ')
                      .slice(0, 30000);

  const { status, body } = await req('POST', 'https://api.anthropic.com/v1/messages', {
    'x-api-key': ANTHROPIC_KEY,
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json',
  }, {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `Extract search results from this page text. Return ONLY a raw JSON array, no markdown, no explanation.
Each object must have: title (string), url (string), desc (string).
Up to 10 real organic results only. Query was: "${q}"

PAGE TEXT:
${trimmed}`,
    }],
  });

  if (status !== 200) throw new Error(`claude ${status}`);
  const json = JSON.parse(body);
  const text = json.content?.[0]?.text || '';
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('claude returned no JSON');
  return JSON.parse(match[0]).filter(r => r.title && r.url);
}

// ── Handler ──
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const { q, engine = 'google', page = '1' } = event.queryStringParameters || {};
  if (!q) return { statusCode: 400, headers, body: JSON.stringify({ error: 'missing q' }) };

  const p = parseInt(page) || 1;
  let source = 'serper';

  try {
    const results = await serperSearch(q, engine, p);
    return { statusCode: 200, headers, body: JSON.stringify({ results, page: p, engine, query: q, source }) };
  } catch (serperErr) {
    // Serper failed or quota exceeded — fall back to Claude
    source = 'claude';
    try {
      const results = await claudeSearch(q, engine, p);
      return { statusCode: 200, headers, body: JSON.stringify({ results, page: p, engine, query: q, source }) };
    } catch (claudeErr) {
      return { statusCode: 502, headers, body: JSON.stringify({
        error: 'all sources failed',
        serper: serperErr.message,
        claude: claudeErr.message,
      })};
    }
  }
};
