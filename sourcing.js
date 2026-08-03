const SETTINGS_KEY = 'sedori_settings_v1';
const PRODUCTS_KEY = 'sedori_products_v1';
const SHIP_TIERS_KEY = 'sedori_ship_tiers_v1';

const settingIds = [
  'set-fx', 'set-pay-fee', 'set-duty', 'set-th-margin', 'set-th-roi',
];

// eBayの標準的な落札手数料（Final Value Fee）率。ライブAPIではなく、
// eBayが公開している料率表のスナップショットです。料率は変更されることがあるため、
// https://www.ebay.com/help/selling/fees-credits-invoices/selling-fees で定期的に確認してください。
const EBAY_FEE_CATEGORIES = {
  standard: { label: '標準（家電・おもちゃ・ホビー・コレクティブルズ等）', rate: 13.25, secondaryRate: 2.35, threshold: 7500 },
  jewelry_watches: { label: 'ジュエリー・腕時計', rate: 15, secondaryRate: 9, threshold: 5000 },
  guitars: { label: '楽器（ギター・ベース）', rate: 6.35, secondaryRate: 2.35, threshold: 7500 },
};

// 送料テーブルの初期値（目安の参考値）。実際の料金は発送方法・配送先国・時期によって
// 異なるため、設定画面から編集してください。
const DEFAULT_SHIP_TIERS = [
  { maxG: 500, priceJpy: 2200 },
  { maxG: 1000, priceJpy: 3000 },
  { maxG: 1500, priceJpy: 3700 },
  { maxG: 2000, priceJpy: 4400 },
  { maxG: 3000, priceJpy: 5700 },
  { maxG: 5000, priceJpy: 8300 },
  { maxG: 10000, priceJpy: 14300 },
  { maxG: 20000, priceJpy: 24300 },
];

function loadSettings() {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  settingIds.forEach((id) => {
    if (saved[id] !== undefined) document.getElementById(id).value = saved[id];
  });
}

function saveSettings() {
  const data = {};
  settingIds.forEach((id) => {
    data[id] = document.getElementById(id).value;
  });
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
}

function getSettings() {
  return {
    fx: Number(document.getElementById('set-fx').value) || 0,
    payFeePct: Number(document.getElementById('set-pay-fee').value) || 0,
    dutyPct: Number(document.getElementById('set-duty').value) || 0,
    thMargin: Number(document.getElementById('set-th-margin').value) || 0,
    thRoi: Number(document.getElementById('set-th-roi').value) || 0,
  };
}

function loadProducts() {
  return JSON.parse(localStorage.getItem(PRODUCTS_KEY) || '[]');
}

function saveProducts(products) {
  localStorage.setItem(PRODUCTS_KEY, JSON.stringify(products));
}

function loadShipTiers() {
  const saved = JSON.parse(localStorage.getItem(SHIP_TIERS_KEY) || 'null');
  return saved || DEFAULT_SHIP_TIERS.map((t) => ({ ...t }));
}

function saveShipTiers(tiers) {
  localStorage.setItem(SHIP_TIERS_KEY, JSON.stringify(tiers));
}

function populateCategorySelect() {
  const select = document.getElementById('in-category');
  select.innerHTML = '';
  Object.entries(EBAY_FEE_CATEGORIES).forEach(([key, cat]) => {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = `${cat.label}（${cat.rate}%）`;
    select.appendChild(option);
  });
}

function renderShipTiers() {
  const tiers = loadShipTiers();
  const list = document.getElementById('ship-tiers-list');
  list.innerHTML = '';

  tiers.forEach((tier, idx) => {
    const row = document.createElement('div');
    row.className = 'tier-row';
    row.innerHTML = `
      〜<input type="number" class="tier-maxg" value="${tier.maxG}" min="1" /> g :
      ¥<input type="number" class="tier-price" value="${tier.priceJpy}" min="0" />
      <button type="button" class="tier-del">削除</button>
    `;

    row.querySelector('.tier-maxg').addEventListener('input', (e) => {
      const next = loadShipTiers();
      next[idx].maxG = Number(e.target.value) || 0;
      saveShipTiers(next);
      render();
    });
    row.querySelector('.tier-price').addEventListener('input', (e) => {
      const next = loadShipTiers();
      next[idx].priceJpy = Number(e.target.value) || 0;
      saveShipTiers(next);
      render();
    });
    row.querySelector('.tier-del').addEventListener('click', () => {
      const next = loadShipTiers().filter((_, i) => i !== idx);
      saveShipTiers(next);
      renderShipTiers();
      render();
    });

    list.appendChild(row);
  });
}

// --- Amazon側: /api/amazon-price（Worker）経由でKeepa APIから現在価格を取得 ---
function extractAsin(input) {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
  if (urlMatch) return urlMatch[1].toUpperCase();
  const bareMatch = trimmed.match(/^[A-Z0-9]{10}$/i);
  return bareMatch ? trimmed.toUpperCase() : null;
}

async function fetchFromKeepa(asin) {
  const res = await fetch(`/api/amazon-price?asin=${encodeURIComponent(asin)}`);
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error || `取得に失敗しました (${res.status})`);
  }
  return data;
}

// --- eBay側: /api/ebay-price（Worker）経由でBrowse APIから相場を取得 ---
async function fetchFromEbay(keyword) {
  const res = await fetch(`/api/ebay-price?q=${encodeURIComponent(keyword)}`);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `取得に失敗しました (${res.status})`);
  }
  return data;
}

// --- 楽天市場側: /api/rakuten-price（Worker）経由で楽天商品検索APIから価格を取得 ---
async function fetchFromRakuten(keyword) {
  const res = await fetch(`/api/rakuten-price?q=${encodeURIComponent(keyword)}`);
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error || `取得に失敗しました (${res.status})`);
  }
  return data;
}

// --- Yahoo!ショッピング側: /api/yahoo-price（Worker）経由で商品検索APIから価格を取得 ---
async function fetchFromYahooShopping(keyword) {
  const res = await fetch(`/api/yahoo-price?q=${encodeURIComponent(keyword)}`);
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error || `取得に失敗しました (${res.status})`);
  }
  return data;
}

function estimateShipping(weightG, tiers) {
  const sorted = [...tiers].sort((a, b) => a.maxG - b.maxG);
  const hit = sorted.find((tier) => weightG <= tier.maxG);
  if (hit) return hit.priceJpy;
  return sorted.length ? sorted[sorted.length - 1].priceJpy : 0;
}

function computeEbayFeeUsd(priceUsd, categoryKey) {
  const cat = EBAY_FEE_CATEGORIES[categoryKey] || EBAY_FEE_CATEGORIES.standard;
  if (priceUsd <= cat.threshold) return priceUsd * (cat.rate / 100);
  return cat.threshold * (cat.rate / 100) + (priceUsd - cat.threshold) * (cat.secondaryRate / 100);
}

function evaluateProduct(product, settings) {
  const revenueJpy = product.priceUsd * settings.fx;
  const ebayFeeJpy = computeEbayFeeUsd(product.priceUsd, product.category) * settings.fx;
  const payFeeJpy = revenueJpy * (settings.payFeePct / 100);
  const feeJpy = ebayFeeJpy + payFeeJpy;
  const dutyJpy = revenueJpy * (settings.dutyPct / 100);
  const shippingJpy = product.shipping;
  const totalCostJpy = product.cost + feeJpy + dutyJpy + shippingJpy;
  const profitJpy = revenueJpy - totalCostJpy;
  const marginPct = revenueJpy > 0 ? (profitJpy / revenueJpy) * 100 : 0;
  const roiPct = product.cost > 0 ? (profitJpy / product.cost) * 100 : 0;

  let verdict = '非推奨';
  if (marginPct >= settings.thMargin && roiPct >= settings.thRoi) {
    verdict = '仕入れ推奨';
  } else if (profitJpy > 0) {
    verdict = '要検討';
  }

  return {
    revenueJpy, feeJpy, dutyJpy, shippingJpy, totalCostJpy,
    profitJpy, marginPct, roiPct, verdict,
  };
}

function verdictClass(verdict) {
  if (verdict === '仕入れ推奨') return 'verdict-good';
  if (verdict === '要検討') return 'verdict-mid';
  return 'verdict-bad';
}

function formatJpy(n) {
  return Math.round(n).toLocaleString('ja-JP');
}

function render() {
  const settings = getSettings();
  const products = loadProducts();
  const onlyRecommend = document.getElementById('filter-recommend-only').checked;
  const tbody = document.getElementById('result-body');
  const emptyMsg = document.getElementById('empty-msg');
  tbody.innerHTML = '';

  const rows = products.map((p) => ({ product: p, result: evaluateProduct(p, settings) }));
  const visible = onlyRecommend ? rows.filter((r) => r.result.verdict === '仕入れ推奨') : rows;

  emptyMsg.classList.toggle('hidden', products.length > 0);
  emptyMsg.textContent = products.length === 0
    ? 'まだ商品が登録されていません。上のフォームから追加してください。'
    : '';

  visible.forEach(({ product, result }) => {
    const tr = document.createElement('tr');
    const categoryLabel = (EBAY_FEE_CATEGORIES[product.category] || EBAY_FEE_CATEGORIES.standard).label;
    tr.innerHTML = `
      <td>${escapeHtml(product.name)}</td>
      <td>${escapeHtml(categoryLabel)}</td>
      <td>${formatJpy(product.cost)}</td>
      <td>${product.priceUsd.toFixed(2)}</td>
      <td>${formatJpy(result.revenueJpy)}</td>
      <td>${formatJpy(result.feeJpy)}</td>
      <td>${formatJpy(result.shippingJpy)}</td>
      <td>${formatJpy(result.dutyJpy)}</td>
      <td>${formatJpy(result.totalCostJpy)}</td>
      <td>${formatJpy(result.profitJpy)}</td>
      <td>${result.marginPct.toFixed(1)}%</td>
      <td>${result.roiPct.toFixed(1)}%</td>
      <td><span class="verdict ${verdictClass(result.verdict)}">${result.verdict}</span></td>
      <td><button type="button" class="del-btn" data-id="${product.id}">削除</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.del-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const next = loadProducts().filter((p) => p.id !== id);
      saveProducts(next);
      render();
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

document.getElementById('product-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const product = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    name: document.getElementById('in-name').value.trim(),
    cost: Number(document.getElementById('in-cost').value) || 0,
    category: document.getElementById('in-category').value,
    priceUsd: Number(document.getElementById('in-price-usd').value) || 0,
    weight: Number(document.getElementById('in-weight').value) || 0,
    shipping: Number(document.getElementById('in-shipping').value) || 0,
  };
  if (!product.name) return;

  const products = loadProducts();
  products.push(product);
  saveProducts(products);
  e.target.reset();
  render();
});

document.getElementById('btn-estimate-shipping').addEventListener('click', () => {
  const weight = Number(document.getElementById('in-weight').value) || 0;
  document.getElementById('in-shipping').value = estimateShipping(weight, loadShipTiers());
});

document.getElementById('btn-add-tier').addEventListener('click', () => {
  const tiers = loadShipTiers();
  const last = tiers[tiers.length - 1];
  tiers.push({ maxG: last ? last.maxG + 1000 : 1000, priceJpy: last ? last.priceJpy + 1000 : 1000 });
  saveShipTiers(tiers);
  renderShipTiers();
});

document.getElementById('btn-fetch-ebay').addEventListener('click', async () => {
  const btn = document.getElementById('btn-fetch-ebay');
  const note = document.getElementById('fetch-note');
  const keyword = document.getElementById('in-name').value.trim();

  if (!keyword) {
    note.textContent = '先に商品名を入力してください（検索キーワードとして使用します）';
    note.classList.add('error');
    return;
  }

  btn.disabled = true;
  btn.textContent = '取得中…';
  note.classList.remove('error');
  note.textContent = '';

  try {
    const data = await fetchFromEbay(keyword);
    if (!data.count) {
      note.textContent = `該当する出品が見つかりませんでした（検索語: ${keyword}）`;
      note.classList.add('error');
    } else {
      document.getElementById('in-price-usd').value = data.median;
      note.textContent = `eBay出品${data.count}件の中央値 $${data.median}（平均$${data.average} / $${data.min}〜$${data.max}）`;
    }
  } catch (err) {
    note.textContent = err.message;
    note.classList.add('error');
  } finally {
    btn.disabled = false;
    btn.textContent = '自動取得';
  }
});

document.getElementById('btn-fetch-amazon').addEventListener('click', async () => {
  const btn = document.getElementById('btn-fetch-amazon');
  const note = document.getElementById('fetch-note-amazon');
  const asin = extractAsin(document.getElementById('in-asin').value);

  if (!asin) {
    note.textContent = 'ASINを認識できませんでした（10桁の英数字、またはAmazon商品URLを入力してください）';
    note.classList.add('error');
    return;
  }

  btn.disabled = true;
  btn.textContent = '取得中…';
  note.classList.remove('error');
  note.textContent = '';

  try {
    const data = await fetchFromKeepa(asin);
    document.getElementById('in-cost').value = data.priceJpy;
    if (!document.getElementById('in-name').value.trim() && data.title) {
      document.getElementById('in-name').value = data.title;
    }
    const sourceLabel = data.source === 'amazon' ? 'Amazon本体' : 'マーケットプレイス新品';
    note.textContent = `Amazon.co.jp 現在価格 ¥${data.priceJpy.toLocaleString('ja-JP')}（${sourceLabel}）`;
  } catch (err) {
    note.textContent = err.message;
    note.classList.add('error');
  } finally {
    btn.disabled = false;
    btn.textContent = '自動取得';
  }
});

function wireKeywordSourceFetch(btnId, noteId, inputId, fetcherFn, sourceLabel) {
  document.getElementById(btnId).addEventListener('click', async () => {
    const btn = document.getElementById(btnId);
    const note = document.getElementById(noteId);
    const keyword = document.getElementById(inputId).value.trim();

    if (!keyword) {
      note.textContent = 'キーワードを入力してください';
      note.classList.add('error');
      return;
    }

    btn.disabled = true;
    btn.textContent = '取得中…';
    note.classList.remove('error');
    note.textContent = '';

    try {
      const data = await fetcherFn(keyword);
      if (!data.count) {
        note.textContent = `該当する商品が見つかりませんでした（検索語: ${keyword}）`;
        note.classList.add('error');
      } else {
        document.getElementById('in-cost').value = data.median;
        if (!document.getElementById('in-name').value.trim()) {
          document.getElementById('in-name').value = keyword;
        }
        note.textContent = `${sourceLabel} ${data.count}件の中央値 ¥${data.median.toLocaleString('ja-JP')}（平均¥${data.average.toLocaleString('ja-JP')} / ¥${data.min.toLocaleString('ja-JP')}〜¥${data.max.toLocaleString('ja-JP')}）`;
      }
    } catch (err) {
      note.textContent = err.message;
      note.classList.add('error');
    } finally {
      btn.disabled = false;
      btn.textContent = '自動取得';
    }
  });
}

wireKeywordSourceFetch('btn-fetch-rakuten', 'fetch-note-rakuten', 'in-rakuten-kw', fetchFromRakuten, '楽天市場');
wireKeywordSourceFetch('btn-fetch-yahoo', 'fetch-note-yahoo', 'in-yahoo-kw', fetchFromYahooShopping, 'Yahoo!ショッピング');

// --- 候補一括スキャン: ASIN/URLのリストをKeepa→eBayの順に自動チェックし、利益率順に提案 ---
const MAX_BATCH_ITEMS = 20;
let scanResults = [];

function parseAsinList(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const asins = [];
  lines.forEach((line) => {
    const asin = extractAsin(line);
    if (asin && !asins.includes(asin)) asins.push(asin);
  });
  return asins.slice(0, MAX_BATCH_ITEMS);
}

function populateBatchCategorySelect() {
  const select = document.getElementById('batch-category');
  select.innerHTML = '';
  Object.entries(EBAY_FEE_CATEGORIES).forEach(([key, cat]) => {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = `${cat.label}（${cat.rate}%）`;
    select.appendChild(option);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scanOneAsin(asin, category, weight, settings, tiers) {
  const amazon = await fetchFromKeepa(asin);
  const ebay = await fetchFromEbay(amazon.title);
  if (!ebay.count) {
    throw new Error(`eBayで該当する出品が見つかりませんでした（検索語: ${amazon.title}）`);
  }
  const product = {
    name: amazon.title,
    cost: amazon.priceJpy,
    category,
    priceUsd: ebay.median,
    weight,
    shipping: estimateShipping(weight, tiers),
  };
  const result = evaluateProduct(product, settings);
  return { product, result };
}

function renderScanResults() {
  const tbody = document.getElementById('batch-body');
  tbody.innerHTML = '';

  const sorted = [...scanResults].sort((a, b) => {
    if (!a.ok && !b.ok) return 0;
    if (!a.ok) return 1;
    if (!b.ok) return -1;
    return b.result.marginPct - a.result.marginPct;
  });

  sorted.forEach((entry, idx) => {
    const tr = document.createElement('tr');
    if (!entry.ok) {
      tr.innerHTML = `<td colspan="7" class="error">${escapeHtml(entry.asin)}: ${escapeHtml(entry.error)}</td><td></td>`;
      tbody.appendChild(tr);
      return;
    }
    const { product, result } = entry;
    tr.innerHTML = `
      <td>${escapeHtml(product.name)}</td>
      <td>${escapeHtml(entry.asin)}</td>
      <td>${formatJpy(product.cost)}</td>
      <td>${product.priceUsd.toFixed(2)}</td>
      <td>${result.marginPct.toFixed(1)}%</td>
      <td>${result.roiPct.toFixed(1)}%</td>
      <td><span class="verdict ${verdictClass(result.verdict)}">${result.verdict}</span></td>
      <td><button type="button" class="add-btn small-btn" data-idx="${idx}">追加</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('[data-idx]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const entry = sorted[Number(btn.getAttribute('data-idx'))];
      if (!entry || !entry.ok) return;
      const products = loadProducts();
      products.push({
        id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
        name: entry.product.name,
        cost: entry.product.cost,
        category: entry.product.category,
        priceUsd: entry.product.priceUsd,
        weight: entry.product.weight,
        shipping: entry.product.shipping,
      });
      saveProducts(products);
      render();
      btn.textContent = '追加済み';
      btn.disabled = true;
    });
  });
}

async function runBatchScan() {
  const btn = document.getElementById('btn-run-scan');
  const progress = document.getElementById('batch-progress');
  const asins = parseAsinList(document.getElementById('batch-input').value);

  if (asins.length === 0) {
    progress.textContent = 'ASINまたはAmazon URLを1行に1つ以上入力してください';
    progress.classList.add('error');
    return;
  }

  const category = document.getElementById('batch-category').value;
  const weight = Number(document.getElementById('batch-weight').value) || 0;
  const settings = getSettings();
  const tiers = loadShipTiers();

  btn.disabled = true;
  progress.classList.remove('error');
  scanResults = [];
  renderScanResults();

  for (let i = 0; i < asins.length; i++) {
    const asin = asins[i];
    progress.textContent = `スキャン中… (${i + 1}/${asins.length}) ${asin}`;
    try {
      const scanned = await scanOneAsin(asin, category, weight, settings, tiers);
      scanResults.push({ asin, ok: true, ...scanned });
    } catch (err) {
      scanResults.push({ asin, ok: false, error: err.message });
    }
    renderScanResults();
    if (i < asins.length - 1) await sleep(300);
  }

  progress.textContent = `スキャン完了（${asins.length}件）`;
  btn.disabled = false;
}

document.getElementById('btn-run-scan').addEventListener('click', runBatchScan);

document.getElementById('filter-recommend-only').addEventListener('change', render);

settingIds.forEach((id) => {
  document.getElementById(id).addEventListener('input', () => {
    saveSettings();
    render();
  });
});

populateCategorySelect();
populateBatchCategorySelect();
renderShipTiers();
loadSettings();
render();
