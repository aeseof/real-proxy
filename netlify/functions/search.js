const https = require('https');

// SearXNG public instances with JSON API support
// Falls through to next if one fails
const INSTANCES = [
  'https://searx.be',
  'https://searxng.site',
  'https://priv.au',
  'https://search.bus-hit.me',
  'https://search.inetol.net',
];

const ENGINE_MAP = {
  google:     'google',
  bing:       'bing',
  britannica: 'google',
};

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function searxng(query, engine, page, instance) {
  const params = new URLSearchParams({
    q:        engine === 'britannica' ? `site:britannica.com ${query}` : query,
    format:   'json',
    engines:  ENGINE_MAP[engine] || 'google',
    pageno:   page,
    language: 'en',
  });
  const url = `${instance}/search?${params}`;
  const { status, body } = await get(url);
  if (status !== 200) throw new Error(`instance returned ${status}`);
  const json = JSON.parse(body);
  if (!json.results) throw new Error('no results field');
  return json.results.map(r => ({
    title: r.title   || '',
    url:   r.url     || '',
    desc:  r.content || r.snippet || '',
  })).filter(r => r.title && r.url);
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const { q, engine = 'google', page = '1' } = event.queryStringParameters || {};
  if (!q) return { statusCode: 400, headers, body: JSON.stringify({ error: 'missing q' }) };

  const p = parseInt(page) || 1;
  const errors = [];

  for (const instance of INSTANCES) {
    try {
      const results = await searxng(q, engine, p, instance);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ results, page: p, engine, query: q, instance }),
      };
    } catch(e) {
      errors.push(`${instance}: ${e.message}`);
      continue;
    }
  }

  return {
    statusCode: 502,
    headers,
    body: JSON.stringify({ error: 'all instances failed', details: errors }),
  };
};
