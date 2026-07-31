// Vercel serverless function: proxies eBay Browse API so the Client Secret
// never reaches the browser. Requires env vars EBAY_CLIENT_ID / EBAY_CLIENT_SECRET.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAppToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt) return cachedToken;

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('EBAY_CLIENT_ID / EBAY_CLIENT_SECRET が設定されていません（Vercelの環境変数を確認してください）');
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
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

module.exports = async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) {
    res.status(400).json({ error: 'クエリパラメータ q（検索キーワード）が必要です' });
    return;
  }

  try {
    const token = await getAppToken();
    const params = new URLSearchParams({ q, limit: '30' });
    const searchRes = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      },
    });

    if (!searchRes.ok) {
      const text = await searchRes.text();
      res.status(searchRes.status).json({ error: `eBay検索に失敗しました (${searchRes.status}): ${text}` });
      return;
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
      res.status(200).json({
        query: q, currency: 'USD', count: 0,
        average: null, median: null, min: null, max: null, samples: [],
      });
      return;
    }

    const prices = items.map((i) => i.price);
    const average = prices.reduce((a, b) => a + b, 0) / prices.length;

    res.status(200).json({
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
    res.status(500).json({ error: err.message });
  }
};
