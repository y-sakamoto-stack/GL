// ─────────────────────────────────────────────────────────
// データソース層
// 本来はここで各ECサイトの公式APIや、外部の価格比較サービス
// （相場データ提供元）を呼び出す。デモ版ではサンプルデータを返す。
// 差し替え可能なように fetchListings() / fetchMarketPrice() として分離している。
// ─────────────────────────────────────────────────────────

const SAMPLE_LISTINGS = [
  { id: 1, name: "Nintendo Switch 有機ELモデル", category: "ゲーム", source: "メルカリ", price: 24800, marketPrice: 32000, condition: "中古 良品" },
  { id: 2, name: "Nintendo Switch 有機ELモデル", category: "ゲーム", source: "ヤフオク!", price: 29500, marketPrice: 32000, condition: "中古 やや傷あり" },
  { id: 3, name: "SONY α6400 ミラーレス一眼", category: "カメラ", source: "メルカリ", price: 58000, marketPrice: 89000, condition: "中古 美品" },
  { id: 4, name: "SONY α6400 ミラーレス一眼", category: "カメラ", source: "楽天市場", price: 92000, marketPrice: 89000, condition: "新品" },
  { id: 5, name: "iPad Air 第5世代 64GB", category: "タブレット", source: "Amazon", price: 68000, marketPrice: 69800, condition: "新品" },
  { id: 6, name: "iPad Air 第5世代 64GB", category: "タブレット", source: "ヤフオク!", price: 45000, marketPrice: 69800, condition: "中古 良品" },
  { id: 7, name: "ダイソン V8 コードレスクリーナー", category: "家電", source: "メルカリ", price: 14000, marketPrice: 28000, condition: "中古 美品" },
  { id: 8, name: "ダイソン V8 コードレスクリーナー", category: "家電", source: "楽天市場", price: 26800, marketPrice: 28000, condition: "新品" },
  { id: 9, name: "バルミューダ ザ・トースター", category: "家電", source: "Amazon", price: 23760, marketPrice: 24200, condition: "新品" },
  { id: 10, name: "バルミューダ ザ・トースター", category: "家電", source: "メルカリ", price: 12500, marketPrice: 24200, condition: "中古 良品" },
  { id: 11, name: "ルイ・ヴィトン モノグラム 財布", category: "ファッション", source: "ヤフオク!", price: 38000, marketPrice: 72000, condition: "中古 やや傷あり" },
  { id: 12, name: "ルイ・ヴィトン モノグラム 財布", category: "ファッション", source: "メルカリ", price: 69000, marketPrice: 72000, condition: "中古 美品" },
  { id: 13, name: "ロレックス デイトナ 風 自動巻き腕時計", category: "ファッション", source: "ヤフオク!", price: 890000, marketPrice: 1450000, condition: "中古" },
  { id: 14, name: "PlayStation 5 本体 (通常版)", category: "ゲーム", source: "楽天市場", price: 66980, marketPrice: 66980, condition: "新品" },
  { id: 15, name: "PlayStation 5 本体 (通常版)", category: "ゲーム", source: "メルカリ", price: 52000, marketPrice: 66980, condition: "中古 良品" },
  { id: 16, name: "ハリー・ポッター全巻セット", category: "本", source: "メルカリ", price: 3200, marketPrice: 6000, condition: "中古 良品" },
  { id: 17, name: "ハリー・ポッター全巻セット", category: "本", source: "Amazon", price: 5980, marketPrice: 6000, condition: "新品" },
  { id: 18, name: "無印良品 折りたたみローテーブル", category: "家具", source: "ヤフオク!", price: 2500, marketPrice: 5990, condition: "中古 良品" },
  { id: 19, name: "IKEA POÄNG チェア", category: "家具", source: "メルカリ", price: 6800, marketPrice: 12900, condition: "中古 美品" },
  { id: 20, name: "MacBook Air M2 13インチ", category: "パソコン", source: "メルカリ", price: 98000, marketPrice: 148800, condition: "中古 美品" },
  { id: 21, name: "MacBook Air M2 13インチ", category: "パソコン", source: "楽天市場", price: 152000, marketPrice: 148800, condition: "新品" },
  { id: 22, name: "エルゴベビー 抱っこ紐", category: "ベビー用品", source: "メルカリ", price: 5500, marketPrice: 15400, condition: "中古 良品" },
];

function fetchListings() {
  // 実際にはここで各サイトの公式APIを叩き、正規化した配列を返す
  return Promise.resolve(SAMPLE_LISTINGS);
}

function fetchMarketPrice(listing) {
  // 実際にはここで外部の価格比較サービスAPIを呼び、
  // 商品名から市場相場（中央値など）を取得する
  return listing.marketPrice;
}

// ─────────────────────────────────────────────────────────
// アプリケーションロジック
// ─────────────────────────────────────────────────────────

const searchInput = document.getElementById("search-input");
const sourceFiltersEl = document.getElementById("source-filters");
const sortSelect = document.getElementById("sort-select");
const bargainOnlyCheckbox = document.getElementById("bargain-only");
const resultsEl = document.getElementById("results");
const summaryEl = document.getElementById("summary");
const emptyStateEl = document.getElementById("empty-state");

let allItems = [];
let activeSources = new Set();

function withDiscount(listing) {
  const marketPrice = fetchMarketPrice(listing);
  const discountAmount = marketPrice - listing.price;
  const discountPercent = marketPrice > 0 ? Math.round((discountAmount / marketPrice) * 100) : 0;
  return { ...listing, marketPrice, discountAmount, discountPercent };
}

function formatYen(n) {
  return `¥${n.toLocaleString("ja-JP")}`;
}

function renderSourceFilters(items) {
  const sources = [...new Set(items.map((i) => i.source))].sort();
  activeSources = new Set(sources);

  sourceFiltersEl.innerHTML = "";
  sources.forEach((source) => {
    const id = `source-${source}`;
    const chip = document.createElement("label");
    chip.className = "chip";
    chip.innerHTML = `
      <input type="checkbox" id="${id}" checked />
      <span>${source}</span>
    `;
    chip.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) {
        activeSources.add(source);
      } else {
        activeSources.delete(source);
      }
      render();
    });
    sourceFiltersEl.appendChild(chip);
  });
}

function getFilteredSortedItems() {
  const keyword = searchInput.value.trim().toLowerCase();
  const bargainOnly = bargainOnlyCheckbox.checked;
  const sortMode = sortSelect.value;

  let items = allItems
    .filter((item) => activeSources.has(item.source))
    .filter((item) => !keyword || item.name.toLowerCase().includes(keyword))
    .filter((item) => !bargainOnly || item.discountPercent > 0);

  const sorters = {
    "discount-desc": (a, b) => b.discountPercent - a.discountPercent,
    "discount-asc": (a, b) => a.discountPercent - b.discountPercent,
    "price-asc": (a, b) => a.price - b.price,
    "price-desc": (a, b) => b.price - a.price,
  };
  items = items.slice().sort(sorters[sortMode]);

  return items;
}

function renderSummary(items) {
  const bargains = items.filter((i) => i.discountPercent > 0);
  if (bargains.length === 0) {
    summaryEl.textContent = "";
    return;
  }
  const best = bargains.reduce((max, i) => (i.discountPercent > max.discountPercent ? i : max), bargains[0]);
  summaryEl.textContent = `お得な商品 ${bargains.length} 件が見つかりました。最大割引率は「${best.name}」の ${best.discountPercent}% 引きです。`;
}

function renderResults(items) {
  resultsEl.innerHTML = "";
  emptyStateEl.classList.toggle("hidden", items.length > 0);

  items.forEach((item) => {
    const card = document.createElement("article");
    card.className = "card";

    const badge =
      item.discountPercent > 0
        ? `<span class="badge bargain">相場より ${item.discountPercent}% 安い</span>`
        : item.discountPercent < 0
        ? `<span class="badge overpriced">相場より ${Math.abs(item.discountPercent)}% 高い</span>`
        : `<span class="badge neutral">相場並み</span>`;

    card.innerHTML = `
      <div class="card-header">
        <span class="source-tag">${item.source}</span>
        ${badge}
      </div>
      <h2 class="item-name">${item.name}</h2>
      <p class="condition">${item.condition}</p>
      <div class="price-row">
        <span class="price">${formatYen(item.price)}</span>
        <span class="market-price">相場 ${formatYen(item.marketPrice)}</span>
      </div>
    `;
    resultsEl.appendChild(card);
  });
}

function render() {
  const items = getFilteredSortedItems();
  renderSummary(items);
  renderResults(items);
}

async function init() {
  const listings = await fetchListings();
  allItems = listings.map(withDiscount);

  renderSourceFilters(allItems);
  render();

  searchInput.addEventListener("input", render);
  sortSelect.addEventListener("change", render);
  bargainOnlyCheckbox.addEventListener("change", render);
}

init();
