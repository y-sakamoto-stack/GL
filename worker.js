// Cloudflare Worker entry point (deployed via `wrangler deploy`).
// Serves the static site (index.html / sourcing.html / *.js / *.css) from
// the assets binding, and handles /api/ebay-price, /api/amazon-price,
// /api/rakuten-price, /api/yahoo-price and /api/fx-rate itself so
// credentials never reach the browser. Set EBAY_CLIENT_ID /
// EBAY_CLIENT_SECRET / KEEPA_API_KEY / RAKUTEN_APP_ID / YAHOO_CLIENT_ID
// as Worker Variables and Secrets (Settings → Variables and Secrets).
// /api/fx-rate needs no credentials (Frankfurter/ECB rates are public).
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

async function searchEbay(q, env) {
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
    throw new Error(`eBay検索に失敗しました (${searchRes.status}): ${text}`);
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
    return { query: q, currency: 'USD', count: 0, average: null, median: null, min: null, max: null, samples: [] };
  }

  const prices = items.map((i) => i.price);
  const average = prices.reduce((a, b) => a + b, 0) / prices.length;

  return {
    query: q,
    currency: 'USD',
    count: items.length,
    average: Number(average.toFixed(2)),
    median: Number(median(prices).toFixed(2)),
    min: Math.min(...prices),
    max: Math.max(...prices),
    samples: items,
    note: '現在出品中（アクティブリスティング）の価格を集計した概算です。落札済み(Sold)相場とは異なる場合があります。',
  };
}

async function handleEbayPrice(request, env) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();

  if (!q) {
    return json({ error: 'クエリパラメータ q（検索キーワード）が必要です' }, 400);
  }

  try {
    return json(await searchEbay(q, env));
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
async function searchRakuten(q, env) {
  const appId = env.RAKUTEN_APP_ID;
  const accessKey = env.RAKUTEN_ACCESS_KEY;
  const affiliateId = env.RAKUTEN_AFFILIATE_ID;
  if (!appId || !accessKey || !affiliateId) {
    throw new Error('RAKUTEN_APP_ID / RAKUTEN_ACCESS_KEY / RAKUTEN_AFFILIATE_ID が設定されていません（WorkerのSettings → Variables and Secretsを確認してください）');
  }

  // 楽天アプリ設定の「アプリケーションURL」に登録したドメインと一致させる必要があります。
  // 別のドメインを登録した場合は env.RAKUTEN_REFERER で上書きしてください。
  // Origin ヘッダーは仕様上スキーム+ホストのみ（パスを含まない）、Referer はフルURLで送る。
  const referer = env.RAKUTEN_REFERER || 'https://ebay-sourcing-tool.ys-god-breath.workers.dev';
  const origin = new URL(referer).origin;

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
    throw new Error(`楽天API検索に失敗しました (${res.status}): ${text}`);
  }

  const data = await res.json();
  // formatVersion=2 は { items: [{itemName, itemPrice, ...}] }（フラット）、
  // formatVersion=1 は { Items: [{ Item: {itemName, itemPrice, ...} }] }（ネスト）。
  // 新APIでどちらが返るか不確実なため両方に対応する。
  const rawList = data.items || data.Items || [];
  const items = rawList
    .map((entry) => entry.Item || entry.item || entry)
    .filter((item) => typeof item.itemPrice === 'number' && item.itemPrice > 0)
    .map((item) => ({ title: item.itemName, price: item.itemPrice, url: item.itemUrl }));

  if (items.length === 0) {
    return { query: q, currency: 'JPY', count: 0, average: null, median: null, min: null, max: null, samples: [] };
  }

  const prices = items.map((i) => i.price);
  const average = prices.reduce((a, b) => a + b, 0) / prices.length;

  return {
    query: q,
    currency: 'JPY',
    count: items.length,
    average: Math.round(average),
    median: Math.round(median(prices)),
    min: Math.min(...prices),
    max: Math.max(...prices),
    samples: items,
    note: '楽天市場の現在の出品価格を集計した概算です。',
  };
}

async function handleRakutenPrice(request, env) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();

  if (!q) {
    return json({ error: 'クエリパラメータ q（検索キーワード）が必要です' }, 400);
  }

  try {
    return json(await searchRakuten(q, env));
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
      samples: items,
      note: 'Yahoo!ショッピングの現在の出品価格を集計した概算です。',
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// Claude API（Anthropic）でeBay転売に向いた検索キーワードを自由に発想させる。
// ANTHROPIC_API_KEY をWorkerのSettings → Variables and Secretsに設定すると有効になる。
// コストを抑えるため一番安価な claude-haiku-4-5 を使用（1回の呼び出しで1円未満程度）。
async function suggestKeywordsWithAI(apiKey, count) {
  const prompt = `あなたは日本国内で仕入れて海外のeBayで販売する「せどり」ビジネスの仕入れ担当です。
利益が出やすそうな商品ジャンル・キーワードを${count}個、自由な発想で提案してください。
特定のカテゴリに偏らず、日本発の商品で海外で人気が出そうなもの（アニメ・ゲーム関連グッズ、伝統工芸、ジュエリー・腕時計、楽器、家電、コレクティブルズなど）を幅広く発想してください。
各キーワードは楽天市場やAmazonで実際に検索して商品がヒットしそうな、具体的な日本語の検索語にしてください（例：「ポケモンカード 25th」「セイコー 腕時計 中古」など）。

以下のJSON配列の形式で、それ以外の文章は一切含めずに出力してください：
[{"keyword": "検索キーワード", "category": "standard", "reason": "利益が出やすいと考えた理由（日本語で1文）"}]

categoryは以下のいずれかにしてください：
- "standard"（家電・おもちゃ・ホビー・コレクティブルズ等）
- "jewelry_watches"（ジュエリー・腕時計）
- "guitars"（楽器・ギター・ベース）`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude APIの呼び出しに失敗しました (${res.status}): ${text}`);
  }

  const data = await res.json();
  const text = (data.content || []).map((block) => block.text || '').join('');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Claudeの応答からキーワード候補を抽出できませんでした');
  }

  let ideas;
  try {
    ideas = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new Error('Claudeの応答のJSON解析に失敗しました: ' + err.message);
  }

  return ideas
    .filter((idea) => idea && typeof idea.keyword === 'string' && idea.keyword.trim())
    .map((idea) => ({
      keyword: idea.keyword.trim(),
      category: ['standard', 'jewelry_watches', 'guitars'].includes(idea.category) ? idea.category : 'standard',
      reason: typeof idea.reason === 'string' ? idea.reason : '',
    }));
}

async function handleAiDiscover(request, env) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json({ error: 'ANTHROPIC_API_KEY が設定されていません（WorkerのSettings → Variables and Secretsを確認してください）' }, 500);
  }

  const url = new URL(request.url);
  const count = Math.min(Math.max(Number(url.searchParams.get('count')) || 10, 1), 20);

  let ideas;
  try {
    ideas = await suggestKeywordsWithAI(apiKey, count);
  } catch (err) {
    return json({ error: err.message }, 500);
  }

  const results = await Promise.allSettled(
    ideas.map(async (idea) => {
      const [rakuten, ebay] = await Promise.allSettled([
        searchRakuten(idea.keyword, env),
        searchEbay(idea.keyword, env),
      ]);
      return {
        keyword: idea.keyword,
        category: idea.category,
        reason: idea.reason,
        rakuten: rakuten.status === 'fulfilled' ? rakuten.value : null,
        rakutenError: rakuten.status === 'rejected' ? rakuten.reason.message : null,
        ebay: ebay.status === 'fulfilled' ? ebay.value : null,
        ebayError: ebay.status === 'rejected' ? ebay.reason.message : null,
      };
    })
  );

  const candidates = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  return json({ candidates });
}

// Frankfurter（ECB公表レートの無料API）。APIキー・登録不要。
// https://frankfurter.dev/
async function handleFxRate() {
  try {
    const res = await fetch('https://api.frankfurter.dev/v2/rate/USD/JPY');
    if (!res.ok) {
      const text = await res.text();
      return json({ error: `為替レートの取得に失敗しました (${res.status}): ${text}` }, res.status);
    }
    const data = await res.json();
    if (typeof data.rate !== 'number') {
      return json({ error: '為替レートのレスポンス形式が想定と異なります' }, 500);
    }
    return json({ rate: data.rate, date: data.date });
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
    if (url.pathname === '/api/fx-rate') {
      return handleFxRate();
    }
    if (url.pathname === '/api/ai-discover') {
      return handleAiDiscover(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
