const SETTINGS_KEY = 'sedori_settings_v1';
const PRODUCTS_KEY = 'sedori_products_v1';

const settingIds = [
  'set-fx', 'set-ebay-fee', 'set-pay-fee', 'set-duty',
  'set-ship-base', 'set-ship-per-g', 'set-th-margin', 'set-th-roi',
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
    ebayFeePct: Number(document.getElementById('set-ebay-fee').value) || 0,
    payFeePct: Number(document.getElementById('set-pay-fee').value) || 0,
    dutyPct: Number(document.getElementById('set-duty').value) || 0,
    shipBase: Number(document.getElementById('set-ship-base').value) || 0,
    shipPerG: Number(document.getElementById('set-ship-per-g').value) || 0,
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

function estimateShipping(weightG, settings) {
  return Math.round(settings.shipBase + settings.shipPerG * weightG);
}

function evaluateProduct(product, settings) {
  const revenueJpy = product.priceUsd * settings.fx;
  const feeJpy = revenueJpy * ((settings.ebayFeePct + settings.payFeePct) / 100);
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
    tr.innerHTML = `
      <td>${escapeHtml(product.name)}</td>
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
  document.getElementById('in-shipping').value = estimateShipping(weight, getSettings());
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

document.getElementById('filter-recommend-only').addEventListener('change', render);

settingIds.forEach((id) => {
  document.getElementById(id).addEventListener('input', () => {
    saveSettings();
    render();
  });
});

loadSettings();
render();
