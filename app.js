// ─────────────────────────────────────────────────────────
// データソース層: 楽天市場 商品検索API (楽天ウェブサービス)
// https://webservice.rakuten.co.jp/api/ichibaitemsearch/
// 無料の「アプリケーションID」が必要（利用者ご自身で取得）。
// ブラウザから直接呼べるよう JSONP で取得する（サーバー不要）。
// ─────────────────────────────────────────────────────────

const RAKUTEN_ENDPOINT = "https://app.rakuten.co.jp/services/api/IchibaItem/Search/20220601";
const APP_ID_STORAGE_KEY = "bargain_finder_rakuten_app_id";

function rakutenJsonp(params) {
  return new Promise((resolve, reject) => {
    const callbackName = `rakutenCb_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const query = new URLSearchParams({
      format: "json",
      hits: "30",
      ...params,
      callback: callbackName,
    });

    const script = document.createElement("script");
    script.src = `${RAKUTEN_ENDPOINT}?${query.toString()}`;

    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("タイムアウトしました。通信環境を確認して再度お試しください。"));
    }, 10000);

    function cleanup() {
      clearTimeout(timeoutId);
      delete window[callbackName];
      script.remove();
    }

    window[callbackName] = (data) => {
      cleanup();
      resolve(data);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("楽天市場APIへの接続に失敗しました。"));
    };

    document.body.appendChild(script);
  });
}

async function fetchRakutenListings(keyword, appId) {
  const data = await rakutenJsonp({ keyword, applicationId: appId, sort: "+itemPrice" });

  if (data.error) {
    const message =
      data.error === "wrong_parameter"
        ? "アプリケーションIDが正しくないか、キーワードが不正です。"
        : data.error_description || data.error;
    throw new Error(message);
  }

  return (data.Items || []).map((wrap) => wrap.Item).map((item, index) => ({
    id: item.itemCode || `${index}`,
    name: item.itemName,
    shop: item.shopName,
    price: item.itemPrice,
    url: item.itemUrl,
    image: item.mediumImageUrls && item.mediumImageUrls[0] ? item.mediumImageUrls[0].imageUrl : "",
  }));
}

function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ─────────────────────────────────────────────────────────
// アプリケーションロジック
// ─────────────────────────────────────────────────────────

const appIdInput = document.getElementById("app-id-input");
const saveAppIdBtn = document.getElementById("save-app-id-btn");
const searchInput = document.getElementById("search-input");
const searchBtn = document.getElementById("search-btn");
const sortSelect = document.getElementById("sort-select");
const bargainOnlyCheckbox = document.getElementById("bargain-only");
const resultsEl = document.getElementById("results");
const summaryEl = document.getElementById("summary");
const emptyStateEl = document.getElementById("empty-state");
const statusEl = document.getElementById("status-message");

let allItems = [];

function formatYen(n) {
  return `¥${n.toLocaleString("ja-JP")}`;
}

function setStatus(message, kind = "info") {
  statusEl.textContent = message;
  statusEl.className = `status-message ${kind}`;
}

function getSavedAppId() {
  return localStorage.getItem(APP_ID_STORAGE_KEY) || "";
}

function getFilteredSortedItems() {
  const bargainOnly = bargainOnlyCheckbox.checked;
  const sortMode = sortSelect.value;

  let items = allItems.filter((item) => !bargainOnly || item.discountPercent > 0);

  const sorters = {
    "discount-desc": (a, b) => b.discountPercent - a.discountPercent,
    "discount-asc": (a, b) => a.discountPercent - b.discountPercent,
    "price-asc": (a, b) => a.price - b.price,
    "price-desc": (a, b) => b.price - a.price,
  };
  return items.slice().sort(sorters[sortMode]);
}

function renderSummary(items) {
  if (allItems.length === 0) {
    summaryEl.textContent = "";
    return;
  }
  const bargains = allItems.filter((i) => i.discountPercent > 0);
  if (bargains.length === 0) {
    summaryEl.textContent = `検索結果 ${allItems.length} 件中、相場より安い商品はありませんでした。`;
    return;
  }
  const best = bargains.reduce((max, i) => (i.discountPercent > max.discountPercent ? i : max), bargains[0]);
  summaryEl.textContent = `検索結果 ${allItems.length} 件中、お得な商品 ${bargains.length} 件。最大割引率は「${best.name}」の ${best.discountPercent}% 引きです。`;
}

function renderResults(items) {
  resultsEl.innerHTML = "";
  emptyStateEl.classList.toggle("hidden", items.length > 0 || allItems.length === 0);

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
      ${item.image ? `<img class="item-image" src="${item.image}" alt="" loading="lazy" />` : ""}
      <div class="card-header">
        <span class="source-tag">${item.shop}</span>
        ${badge}
      </div>
      <h2 class="item-name">
        <a href="${item.url}" target="_blank" rel="noopener noreferrer">${item.name}</a>
      </h2>
      <div class="price-row">
        <span class="price">${formatYen(item.price)}</span>
        <span class="market-price">相場(中央値) ${formatYen(item.marketPrice)}</span>
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

async function runSearch() {
  const appId = appIdInput.value.trim();
  const keyword = searchInput.value.trim();

  if (!appId) {
    setStatus("楽天ウェブサービスのアプリケーションIDを入力してください。", "error");
    return;
  }
  if (!keyword) {
    setStatus("検索キーワードを入力してください。", "error");
    return;
  }

  searchBtn.disabled = true;
  setStatus("検索中...", "info");
  resultsEl.innerHTML = "";
  summaryEl.textContent = "";
  emptyStateEl.classList.add("hidden");

  try {
    const items = await fetchRakutenListings(keyword, appId);

    if (items.length === 0) {
      allItems = [];
      setStatus("該当する商品が見つかりませんでした。", "info");
      render();
      return;
    }

    const marketPrice = Math.round(median(items.map((i) => i.price)));
    allItems = items.map((item) => {
      const discountAmount = marketPrice - item.price;
      const discountPercent = marketPrice > 0 ? Math.round((discountAmount / marketPrice) * 100) : 0;
      return { ...item, marketPrice, discountAmount, discountPercent };
    });

    setStatus("", "info");
    render();
  } catch (err) {
    setStatus(err.message, "error");
  } finally {
    searchBtn.disabled = false;
  }
}

function init() {
  appIdInput.value = getSavedAppId();

  saveAppIdBtn.addEventListener("click", () => {
    localStorage.setItem(APP_ID_STORAGE_KEY, appIdInput.value.trim());
    setStatus("アプリケーションIDを保存しました。", "info");
  });

  searchBtn.addEventListener("click", runSearch);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });

  sortSelect.addEventListener("change", render);
  bargainOnlyCheckbox.addEventListener("change", render);
}

init();
