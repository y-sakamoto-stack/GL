// ─────────────────────────────────────────────────────────
// データソース層: 楽天市場 商品検索API (楽天ウェブサービス)
// https://webservice.rakuten.co.jp/documentation/ichiba-item-search
// 無料の「アプリケーションID」と「アクセスキー」が必要（利用者ご自身で取得）。
// ブラウザから直接呼べるよう JSONP で取得する（サーバー不要）。
// このAPIはリクエスト元ページのHTTP Referrerを要求するため、
// file:// で直接開くと REFERRER_MISSING エラーになる場合がある。
// ─────────────────────────────────────────────────────────

const RAKUTEN_ENDPOINT = "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701";
const APP_ID_STORAGE_KEY = "bargain_finder_rakuten_app_id";
const ACCESS_KEY_STORAGE_KEY = "bargain_finder_rakuten_access_key";

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
    script.referrerPolicy = "unsafe-url";

    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("タイムアウトしました（JSONP）。通信環境を確認して再度お試しください。"));
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
      reject(new Error("JSONP読み込みに失敗しました（詳細不明。ブラウザがスクリプトの読み込みを拒否しました）。"));
    };

    document.body.appendChild(script);
  });
}

async function rakutenFetch(params) {
  const query = new URLSearchParams({ format: "json", hits: "30", ...params });
  const response = await fetch(`${RAKUTEN_ENDPOINT}?${query.toString()}`, {
    method: "GET",
    referrerPolicy: "unsafe-url",
  });
  return response.json();
}

async function fetchRakutenListings(keyword, appId, accessKey) {
  // sort指定なし = 楽天標準の関連度順。価格順で絞ると「一番安い30件」しか
  // 取得できず、相場(中央値・平均値)が実際より安く偏ってしまうため使わない。
  const params = { keyword, applicationId: appId, accessKey };

  let data;
  try {
    // まず fetch を試す（CORSに対応していれば、失敗時も実際のエラー内容が読める）
    data = await rakutenFetch(params);
  } catch (fetchErr) {
    // fetchがCORS等でブロックされた場合は JSONP にフォールバック
    data = await rakutenJsonp(params);
  }

  if (data.errors) {
    const { errorMessage } = data.errors;
    if (errorMessage && errorMessage.includes("REFERRER")) {
      throw new Error(
        `楽天APIが参照元(Referrer)情報を要求していますが、送信されませんでした（${errorMessage}）。file:// で直接開いている場合はローカルサーバー経由で開いてください。`
      );
    }
    throw new Error(errorMessage || "楽天APIがエラーを返しました。");
  }
  if (data.error) {
    throw new Error(data.error_description || data.error);
  }

  // 楽天の検索は単語ごとのゆるい一致になりやすく、商品名の別々の場所に
  // 単語が散らばっているだけの無関係な商品も返ってくることがある。
  // そのため商品名に検索語がすべて含まれているものだけに絞り込む。
  // さらに、本体名を含んだアクセサリー（ケース等）が大量に紛れ込むため、
  // ユーザーが明示的に検索していないアクセサリー系の単語を含む商品を除外する。
  return (data.Items || [])
    .map((wrap) => wrap.Item)
    .filter((item) => matchesAllTerms(item.itemName, keyword))
    .filter((item) => !isLikelyAccessory(item.itemName, keyword))
    .map((item, index) => ({
      id: item.itemCode || `${index}`,
      name: item.itemName,
      shop: item.shopName,
      price: item.itemPrice,
      url: item.itemUrl,
      image: item.mediumImageUrls && item.mediumImageUrls[0] ? item.mediumImageUrls[0].imageUrl : "",
    }));
}

function matchesAllTerms(name, keyword) {
  const terms = keyword.split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
  const lowerName = (name || "").toLowerCase();
  return terms.every((term) => lowerName.includes(term));
}

const ACCESSORY_KEYWORDS = [
  "ケース", "カバー", "フィルム", "保護シート", "保護シール", "収納",
  "ポーチ", "ストラップ", "スタンド", "ステッカー", "シール", "グリップ",
  "互換", "交換用", "タッチペン", "アクセサリー",
];

function isLikelyAccessory(name, keyword) {
  const lowerName = (name || "").toLowerCase();
  const lowerKeyword = keyword.toLowerCase();
  return ACCESSORY_KEYWORDS.some((word) => {
    const lowerWord = word.toLowerCase();
    if (lowerKeyword.includes(lowerWord)) return false; // ユーザーがその単語自体を検索している場合は除外しない
    return lowerName.includes(lowerWord);
  });
}

function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function average(numbers) {
  return numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
}

// ─────────────────────────────────────────────────────────
// アプリケーションロジック
// ─────────────────────────────────────────────────────────

const appIdInput = document.getElementById("app-id-input");
const accessKeyInput = document.getElementById("access-key-input");
const saveAppIdBtn = document.getElementById("save-app-id-btn");
const searchInput = document.getElementById("search-input");
const searchBtn = document.getElementById("search-btn");
const sortSelect = document.getElementById("sort-select");
const bargainOnlyCheckbox = document.getElementById("bargain-only");
const resultsEl = document.getElementById("results");
const summaryEl = document.getElementById("summary");
const emptyStateEl = document.getElementById("empty-state");
const statusEl = document.getElementById("status-message");
const marketSummaryEl = document.getElementById("market-summary");
const statMedianEl = document.getElementById("stat-median");
const statAverageEl = document.getElementById("stat-average");
const statMinEl = document.getElementById("stat-min");
const statMaxEl = document.getElementById("stat-max");
const statCountEl = document.getElementById("stat-count");

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

function getSavedAccessKey() {
  return localStorage.getItem(ACCESS_KEY_STORAGE_KEY) || "";
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

function renderMarketSummary(items) {
  if (items.length === 0) {
    marketSummaryEl.classList.add("hidden");
    return;
  }
  const prices = items.map((i) => i.price);
  statMedianEl.textContent = formatYen(Math.round(median(prices)));
  statAverageEl.textContent = formatYen(Math.round(average(prices)));
  statMinEl.textContent = formatYen(Math.min(...prices));
  statMaxEl.textContent = formatYen(Math.max(...prices));
  statCountEl.textContent = `${items.length} 件`;
  marketSummaryEl.classList.remove("hidden");
}

function render() {
  const items = getFilteredSortedItems();
  renderMarketSummary(allItems);
  renderSummary(items);
  renderResults(items);
}

async function runSearch() {
  const appId = appIdInput.value.trim();
  const accessKey = accessKeyInput.value.trim();
  const keyword = searchInput.value.trim();

  if (!appId) {
    setStatus("楽天ウェブサービスのアプリケーションIDを入力してください。", "error");
    return;
  }
  if (!accessKey) {
    setStatus("楽天ウェブサービスのアクセスキーを入力してください。", "error");
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
  marketSummaryEl.classList.add("hidden");

  try {
    // 楽天の商品検索APIに新品/中古を区別する専用パラメータがないため、
    // キーワードに「中古」を加えて絞り込む（完全な保証はできない簡易的な方法）
    const items = await fetchRakutenListings(`${keyword} 中古`, appId, accessKey);

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
  accessKeyInput.value = getSavedAccessKey();

  saveAppIdBtn.addEventListener("click", () => {
    localStorage.setItem(APP_ID_STORAGE_KEY, appIdInput.value.trim());
    localStorage.setItem(ACCESS_KEY_STORAGE_KEY, accessKeyInput.value.trim());
    setStatus("アプリケーションID・アクセスキーを保存しました。", "info");
  });

  searchBtn.addEventListener("click", runSearch);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });

  sortSelect.addEventListener("change", render);
  bargainOnlyCheckbox.addEventListener("change", render);
}

init();
