const priceEl = document.getElementById('price');
const totalSlotsEl = document.getElementById('total-slots');
const prizeBody = document.getElementById('prize-body');
const addRowBtn = document.getElementById('add-row-btn');
const nCountEl = document.getElementById('n-count');
const nResultEl = document.getElementById('n-result');
const warningEl = document.getElementById('warning-msg');

const outPrizeCount = document.getElementById('out-prize-count');
const outMissCount = document.getElementById('out-miss-count');
const outEv = document.getElementById('out-ev');
const outRate = document.getElementById('out-rate');
const outProfit = document.getElementById('out-profit');
const outAllProfit = document.getElementById('out-all-profit');

// 直近の計算結果（口数指定の期待収支で使い回す）
let lastEv = null;
let lastPrice = null;

function formatYen(n) {
  return '¥' + Math.round(n).toLocaleString('ja-JP');
}

function formatSigned(n) {
  const rounded = Math.round(n);
  const sign = rounded > 0 ? '+' : rounded < 0 ? '-' : '';
  return sign + formatYen(Math.abs(rounded));
}

function addRow(name = '', count = '', value = '') {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="col-name"><input type="text" class="row-name" placeholder="例: Aランクカード" value="${name}" /></td>
    <td class="col-count"><input type="number" class="row-count" min="0" inputmode="numeric" value="${count}" /></td>
    <td class="col-value"><input type="number" class="row-value" min="0" inputmode="numeric" value="${value}" /></td>
    <td class="col-del"><button type="button" class="remove-btn" title="削除">×</button></td>
  `;
  prizeBody.appendChild(tr);
}

function removeRow(tr) {
  tr.remove();
  calculate();
}

function readRows() {
  return Array.from(prizeBody.querySelectorAll('tr')).map((tr) => {
    const count = parseFloat(tr.querySelector('.row-count').value) || 0;
    const value = parseFloat(tr.querySelector('.row-value').value) || 0;
    return { count, value };
  });
}

function calculate() {
  const price = parseFloat(priceEl.value) || 0;
  const rows = readRows();

  const prizeCount = rows.reduce((sum, r) => sum + r.count, 0);
  const prizeValueSum = rows.reduce((sum, r) => sum + r.count * r.value, 0);

  const totalSlotsInput = totalSlotsEl.value.trim();
  const totalSlots = totalSlotsInput === '' ? prizeCount : parseFloat(totalSlotsInput) || 0;

  outPrizeCount.textContent = `${prizeCount.toLocaleString('ja-JP')} 本`;

  warningEl.classList.add('hidden');

  if (totalSlots <= 0 || prizeCount === 0) {
    outMissCount.textContent = '-';
    outEv.textContent = '-';
    outRate.textContent = '-';
    outProfit.textContent = '-';
    outAllProfit.textContent = '-';
    lastEv = null;
    lastPrice = null;
    updateNResult();
    return;
  }

  if (prizeCount > totalSlots) {
    warningEl.textContent = '景品本数の合計が総口数を超えています。総口数を見直してください。';
    warningEl.classList.remove('hidden');
  }

  const missCount = Math.max(totalSlots - prizeCount, 0);
  const ev = prizeValueSum / totalSlots;
  const profit = ev - price;
  const rate = price > 0 ? (ev / price) * 100 : null;
  const allProfit = prizeValueSum - price * totalSlots;

  outMissCount.textContent = `${missCount.toLocaleString('ja-JP')} 本`;
  outEv.textContent = formatYen(ev);
  outRate.textContent = rate === null ? '-' : `${rate.toFixed(1)} %`;
  outProfit.textContent = formatSigned(profit);
  outProfit.className = 'result-value' + (profit >= 0 ? ' positive' : ' negative');
  outAllProfit.textContent = formatSigned(allProfit);
  outAllProfit.className = 'result-value' + (allProfit >= 0 ? ' positive' : ' negative');

  lastEv = ev;
  lastPrice = price;
  updateNResult();
}

function updateNResult() {
  const n = parseFloat(nCountEl.value) || 0;
  if (lastEv === null || n <= 0) {
    nResultEl.textContent = '-';
    nResultEl.className = 'n-result';
    return;
  }
  const total = (lastEv - lastPrice) * n;
  nResultEl.textContent = `${n}口購入時の期待収支: ${formatSigned(total)}`;
  nResultEl.className = 'n-result' + (total >= 0 ? ' positive' : ' negative');
}

addRowBtn.addEventListener('click', () => {
  addRow();
  calculate();
});

prizeBody.addEventListener('input', calculate);

prizeBody.addEventListener('click', (e) => {
  if (e.target.classList.contains('remove-btn')) {
    removeRow(e.target.closest('tr'));
  }
});

priceEl.addEventListener('input', calculate);
totalSlotsEl.addEventListener('input', calculate);
nCountEl.addEventListener('input', updateNResult);

// 初期表示用のサンプル行
addRow('Sランクカード', 1, 30000);
addRow('Aランクカード', 5, 3000);
addRow('Bランクカード', 20, 500);
calculate();
