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

// --- 将来のAPI連携用スタブ ---
// APIキー取得後、実際のKeepa API / eBay APIの呼び出しに置き換える
async function fetchFromKeepa(asinOrUrl) {
  throw new Error('Keepa APIは未接続です。設定後にこの関数を実装してください。');
}

async function fetchFromEbay(keyword) {
  throw new Error('eBay APIは未接続です。設定後にこの関数を実装してください。');
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

document.getElementById('filter-recommend-only').addEventListener('change', render);

settingIds.forEach((id) => {
  document.getElementById(id).addEventListener('input', () => {
    saveSettings();
    render();
  });
});

loadSettings();
render();
