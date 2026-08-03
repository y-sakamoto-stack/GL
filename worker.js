// Cloudflare Worker entry point (deployed via `wrangler deploy`).
// Serves the static site (index.html / sourcing.html / *.js / *.css) from
// the assets binding, and handles /api/ebay-price itself so the eBay Client
// Secret never reaches the browser. Set EBAY_CLIENT_ID / EBAY_CLIENT_SECRET
// as Worker Variables and Secrets (Settings → Variables and Secrets).
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAppToken(env) {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt) return cachedToken;

  const clientId = env.EBAY_CLIENT_ID;
  const clientSecret = env.EBAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('EBAY_CLIENT_ID / EBAY_CLIENT_SECRET が設定されていません（WorkerのSettings → Variables and Secretsを確認してください）');
  }

  const basicAuth = btoa(`${clientId}:${clientSecret}`);
  const tokenRes = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api.ebay.com/oauth/api_scope',
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`eBay OAuthトークン取得に失敗しました (${tokenRes.status}): ${text}`);
  }

  const data = await tokenRes.json();
  cachedToken = data.access_token;
  cachedTokenExpiresAt = now + (data.expires_in - 60) * 1000;
  return cachedToken;
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleEbayPrice(request, env) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();

  if (!q) {
    return json({ error: 'クエリパラメータ q（検索キーワード）が必要です' }, 400);
  }

  try {
    const token = await getAppToken(env);
    const params = new URLSearchParams({ q, limit: '30' });
    const searchRes = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      },
    });

    if (!searchRes.ok) {
      const text = await searchRes.text();
      return json({ error: `eBay検索に失敗しました (${searchRes.status}): ${text}` }, searchRes.status);
    }

    const data = await searchRes.json();
    const items = (data.itemSummaries || [])
      .filter((item) => item.price && item.price.currency === 'USD')
      .map((item) => ({
        title: item.title,
        price: Number(item.price.value),
        condition: item.condition || '',
        url: item.itemWebUrl,
      }));

    if (items.length === 0) {
      return json({
        query: q, currency: 'USD', count: 0,
        average: null, median: null, min: null, max: null, samples: [],
      });
    }

    const prices = items.map((i) => i.price);
    const average = prices.reduce((a, b) => a + b, 0) / prices.length;

    return json({
      query: q,
      currency: 'USD',
      count: items.length,
      average: Number(average.toFixed(2)),
      median: Number(median(prices).toFixed(2)),
      min: Math.min(...prices),
      max: Math.max(...prices),
      samples: items.slice(0, 5),
      note: '現在出品中（アクティブリスティング）の価格を集計した概算です。落札済み(Sold)相場とは異なる場合があります。',
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/ebay-price') {
      return handleEbayPrice(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
