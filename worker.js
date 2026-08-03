// Cloudflare Worker entry point (deployed via `wrangler deploy`).
// Serves the static site (index.html / sourcing.html / *.js / *.css) from
// the assets binding, and handles /api/ebay-price, /api/amazon-price,
// /api/rakuten-price and /api/yahoo-price itself so credentials never
// reach the browser. Set EBAY_CLIENT_ID / EBAY_CLIENT_SECRET /
// KEEPA_API_KEY / RAKUTEN_APP_ID / YAHOO_CLIENT_ID as Worker Variables
// and Secrets (Settings → Variables and Secrets).
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

// Keepa domain id: 5 = Amazon.co.jp (override with env.KEEPA_DOMAIN for other marketplaces).
// https://keepa.com/#!discuss/t/product-object/116 — stats.current index 0 = Amazon price, 1 = new (3rd party) price.
// JPY has no minor currency unit, so unlike USD/EUR the value from Keepa is not divided by 100.
async function handleAmazonPrice(request, env) {
  const url = new URL(request.url);
  const asin = (url.searchParams.get('asin') || '').trim().toUpperCase();

  if (!asin) {
    return json({ error: 'クエリパラメータ asin が必要です' }, 400);
  }

  const apiKey = env.KEEPA_API_KEY;
  if (!apiKey) {
    return json({ error: 'KEEPA_API_KEY が設定されていません（WorkerのSettings → Variables and Secretsを確認してください）' }, 500);
  }

  try {
    const domain = env.KEEPA_DOMAIN || '5';
    const params = new URLSearchParams({ key: apiKey, domain, asin, stats: '1', history: '0' });
    const res = await fetch(`https://api.keepa.com/product?${params}`);

    if (!res.ok) {
      const text = await res.text();
      return json({ error: `Keepa APIエラー (${res.status}): ${text}` }, res.status);
    }

    const data = await res.json();
    const product = (data.products || [])[0];
    if (!product) {
      return json({ error: `該当するASINの商品が見つかりませんでした（ASIN: ${asin}）` }, 404);
    }

    const current = (product.stats && product.stats.current) || [];
    const amazonPrice = current[0];
    const newPrice = current[1];
    const raw = amazonPrice > 0 ? amazonPrice : newPrice;

    if (!raw || raw <= 0) {
      return json({ error: '現在の価格データが取得できませんでした（在庫切れの可能性があります）' }, 200);
    }

    return json({
      asin,
      title: product.title,
      priceJpy: raw,
      source: amazonPrice > 0 ? 'amazon' : 'marketplace',
      note: 'Keepa APIから取得した現在価格です。在庫状況によって変動します。',
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// 楽天商品検索API（IchibaItem/Search）。2026年5月の楽天API刷新後の新方式:
// - エンドポイントが app.rakuten.co.jp/services/api → openapi.rakuten.co.jp/ichibams/api に変更
// - applicationId（UUID形式）、accessKey（pk_で始まる）、affiliateId の3つがすべて必須に
// - 楽天アプリ設定の「アプリケーションURL（Allowed Website）」と一致するOrigin/Refererヘッダーが必須
// https://webservice.rakuten.co.jp/documentation/ichiba-item-search
async function handleRakutenPrice(request, env) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();

  if (!q) {
    return json({ error: 'クエリパラメータ q（検索キーワード）が必要です' }, 400);
  }

  const appId = env.RAKUTEN_APP_ID;
  const accessKey = env.RAKUTEN_ACCESS_KEY;
  const affiliateId = env.RAKUTEN_AFFILIATE_ID;
  if (!appId || !accessKey || !affiliateId) {
    return json({ error: 'RAKUTEN_APP_ID / RAKUTEN_ACCESS_KEY / RAKUTEN_AFFILIATE_ID が設定されていません（WorkerのSettings → Variables and Secretsを確認してください）' }, 500);
  }

  // 楽天アプリ設定の「アプリケーションURL」に登録したドメインと一致させる必要があります。
  // 別のドメインを登録した場合は env.RAKUTEN_REFERER で上書きしてください。
  // Origin ヘッダーは仕様上スキーム+ホストのみ（パスを含まない）、Referer はフルURLで送る。
  const referer = env.RAKUTEN_REFERER || 'https://ebay-sourcing-tool.ys-god-breath.workers.dev';
  const origin = new URL(referer).origin;

  try {
    const params = new URLSearchParams({
      applicationId: appId,
      accessKey,
      affiliateId,
      keyword: q,
      format: 'json',
      formatVersion: '2',
      hits: '30',
    });
    const res = await fetch(`https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260401?${params}`, {
      headers: { Origin: origin, Referer: referer },
    });

    if (!res.ok) {
      const text = await res.text();
      return json({ error: `楽天API検索に失敗しました (${res.status}): ${text}` }, res.status);
    }

    const data = await res.json();
    const items = (data.items || [])
      .filter((item) => typeof item.itemPrice === 'number' && item.itemPrice > 0)
      .map((item) => ({ title: item.itemName, price: item.itemPrice, url: item.itemUrl }));

    if (items.length === 0) {
      return json({ query: q, currency: 'JPY', count: 0, average: null, median: null, min: null, max: null, samples: [] });
    }

    const prices = items.map((i) => i.price);
    const average = prices.reduce((a, b) => a + b, 0) / prices.length;

    return json({
      query: q,
      currency: 'JPY',
      count: items.length,
      average: Math.round(average),
      median: Math.round(median(prices)),
      min: Math.min(...prices),
      max: Math.max(...prices),
      samples: items.slice(0, 5),
      note: '楽天市場の現在の出品価格を集計した概算です。',
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// Yahoo!ショッピング商品検索API V3。無料のYahoo!デベロッパーネットワーク登録でClient IDを取得できます。
// https://developer.yahoo.co.jp/webapi/shopping/shopping/v3/itemsearch.html
async function handleYahooPrice(request, env) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();

  if (!q) {
    return json({ error: 'クエリパラメータ q（検索キーワード）が必要です' }, 400);
  }

  const clientId = env.YAHOO_CLIENT_ID;
  if (!clientId) {
    return json({ error: 'YAHOO_CLIENT_ID が設定されていません（WorkerのSettings → Variables and Secretsを確認してください）' }, 500);
  }

  try {
    const params = new URLSearchParams({ appid: clientId, query: q, results: '30' });
    const res = await fetch(`https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch?${params}`);

    if (!res.ok) {
      const text = await res.text();
      return json({ error: `Yahoo!ショッピング検索に失敗しました (${res.status}): ${text}` }, res.status);
    }

    const data = await res.json();
    const items = (data.hits || [])
      .filter((item) => typeof item.price === 'number' && item.price > 0)
      .map((item) => ({ title: item.name, price: item.price, url: item.url }));

    if (items.length === 0) {
      return json({ query: q, currency: 'JPY', count: 0, average: null, median: null, min: null, max: null, samples: [] });
    }

    const prices = items.map((i) => i.price);
    const average = prices.reduce((a, b) => a + b, 0) / prices.length;

    return json({
      query: q,
      currency: 'JPY',
      count: items.length,
      average: Math.round(average),
      median: Math.round(median(prices)),
      min: Math.min(...prices),
      max: Math.max(...prices),
      samples: items.slice(0, 5),
      note: 'Yahoo!ショッピングの現在の出品価格を集計した概算です。',
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
    if (url.pathname === '/api/amazon-price') {
      return handleAmazonPrice(request, env);
    }
    if (url.pathname === '/api/rakuten-price') {
      return handleRakutenPrice(request, env);
    }
    if (url.pathname === '/api/yahoo-price') {
      return handleYahooPrice(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
