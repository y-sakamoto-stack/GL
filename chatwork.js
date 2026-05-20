const CW_API = 'https://api.chatwork.com/v2';
const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const CLAUDE_BATCH_SIZE = 15;

const cwTokenEl = document.getElementById('cw-token');
const claudeKeyEl = document.getElementById('claude-key');
const periodEl = document.getElementById('period');
const settingsEl = document.getElementById('settings');
const settingsToggle = document.getElementById('settings-toggle');
const saveSettingsBtn = document.getElementById('save-settings');
const clearSettingsBtn = document.getElementById('clear-settings');
const analyzeBtn = document.getElementById('analyze-btn');
const btnLabel = document.getElementById('btn-label');
const statusBar = document.getElementById('status-bar');
const statusText = document.getElementById('status-text');
const progressBar = document.getElementById('progress-bar');
const summaryEl = document.getElementById('summary');
const summaryText = document.getElementById('summary-text');
const resultsEl = document.getElementById('results');

// --- Storage (chrome.storage.local でサンドボックス保存) ---

function loadSettings() {
  chrome.storage.local.get(['cwToken', 'claudeKey', 'period'], (data) => {
    if (data.cwToken) cwTokenEl.value = data.cwToken;
    if (data.claudeKey) claudeKeyEl.value = data.claudeKey;
    if (data.period) periodEl.value = data.period;
  });
}

function saveSettings() {
  const cwToken = cwTokenEl.value.trim();
  const claudeKey = claudeKeyEl.value.trim();
  if (!cwToken) {
    showError('APIトークンを入力してください。');
    return;
  }
  chrome.storage.local.set({ cwToken, claudeKey, period: periodEl.value }, () => {
    settingsEl.classList.add('hidden');
    setStatus('設定を保存しました', 100);
  });
}

function clearSettings() {
  if (!confirm('保存されているAPIトークンとAPIキーを削除しますか？')) return;
  chrome.storage.local.remove(['cwToken', 'claudeKey'], () => {
    cwTokenEl.value = '';
    claudeKeyEl.value = '';
    setStatus('トークンを削除しました', 100);
  });
}

// --- Chatwork API ---

async function cwFetch(path, token) {
  const res = await fetch(`${CW_API}${path}`, {
    headers: { 'X-ChatWorkToken': token },
  });
  if (res.status === 429) {
    throw new Error('Chatwork API のレート制限に達しました。しばらく待ってから再試行してください。');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Chatwork API エラー (${res.status})${body ? ': ' + body : ''}`);
  }
  return res.json();
}

// --- Mention detection ---

function isMentionedInBody(body, accountId) {
  const id = String(accountId);
  return (
    body.includes(`[To:${id}]`) ||
    body.includes(`[toall]`) ||
    body.includes(`[rp aid=${id} `) ||
    body.includes(`[rp aid=${id}]`)
  );
}

function getMentionType(body, accountId) {
  const id = String(accountId);
  if (body.includes(`[To:${id}]`)) return 'TO';
  if (body.includes(`[toall]`)) return 'ALL';
  if (body.includes(`[rp aid=${id}`)) return 'REPLY';
  return 'UNKNOWN';
}

// --- Claude API ---

async function classifyBatch(claudeKey, batch) {
  const items = batch.map((c, i) => {
    const body = c.msg.body
      .replace(/\[To:\d+\]/g, '')
      .replace(/\[toall\]/g, '')
      .replace(/\[rp[^\]]*\]/g, '')
      .trim()
      .slice(0, 400);
    return `[${i}] 送信者: ${c.msg.account.name} / ルーム: ${c.room.name}\n${body}`;
  }).join('\n---\n');

  const prompt = `以下のChatworkメッセージのうち、受信者が返信または対応すべきものを判定してください。

${items}

判定基準:
- 返信必要: 質問・依頼・確認依頼・レビュー依頼・タスク依頼・承認依頼
- 返信不要: 情報共有のみ・完了報告・挨拶のみ・独り言

JSON配列のみを返してください（説明不要）:
[{"index": 0, "needs_reply": true, "reason": "理由を簡潔に"}, ...]`;

  const res = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: {
      'x-api-key': claudeKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Claude API エラー (${res.status})${body ? ': ' + body : ''}`);
  }

  const data = await res.json();
  const text = data.content[0].text;
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  return JSON.parse(match[0]);
}

async function classifyWithClaude(claudeKey, candidates) {
  const results = [];
  for (let i = 0; i < candidates.length; i += CLAUDE_BATCH_SIZE) {
    const batch = candidates.slice(i, i + CLAUDE_BATCH_SIZE);
    const batchResults = await classifyBatch(claudeKey, batch);
    // Adjust indices to global position
    for (const r of batchResults) {
      results.push({ ...r, index: r.index + i });
    }
  }
  return results;
}

// --- UI helpers ---

function setStatus(msg, progress = null) {
  statusText.textContent = msg;
  statusBar.classList.remove('hidden');
  if (progress !== null) {
    progressBar.style.width = `${Math.min(100, progress)}%`;
  }
}

function showError(msg) {
  resultsEl.innerHTML = `<div class="error-msg">${escapeHtml(msg)}</div>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(unixSec) {
  const d = new Date(unixSec * 1000);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('ja-JP', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

const BADGE_LABEL = { TO: 'TO あり', ALL: 'toall', REPLY: 'リプライ' };
const BADGE_CLASS = { TO: 'badge-to', ALL: 'badge-all', REPLY: 'badge-reply' };

function renderResults(items) {
  if (items.length === 0) {
    resultsEl.innerHTML = '<div class="empty">返信が必要なメッセージはありません 🎉</div>';
    return;
  }

  // Sort newest first
  const sorted = [...items].sort((a, b) => b.msg.send_time - a.msg.send_time);

  resultsEl.innerHTML = sorted.map(({ room, msg, reason, mentionType }) => {
    const cleaned = msg.body
      .replace(/\[To:\d+\]/g, '')
      .replace(/\[toall\]/g, '')
      .replace(/\[rp[^\]]*\]/g, '')
      .trim();
    const preview = cleaned.slice(0, 200) + (cleaned.length > 200 ? '…' : '');
    const roomUrl = `https://www.chatwork.com/#!rid${room.room_id}`;
    const badgeLabel = BADGE_LABEL[mentionType] || mentionType;
    const badgeClass = BADGE_CLASS[mentionType] || 'badge-to';

    return `
      <div class="message-card">
        <div class="card-header">
          <span class="room-name" title="${escapeHtml(room.name)}">${escapeHtml(room.name)}</span>
          <span class="mention-badge ${badgeClass}">${badgeLabel}</span>
        </div>
        <div class="message-meta">
          <span class="sender">${escapeHtml(msg.account.name)}</span>
          <span class="time">${formatTime(msg.send_time)}</span>
        </div>
        <div class="message-body">${escapeHtml(preview)}</div>
        ${reason ? `<div class="ai-reason">💡 ${escapeHtml(reason)}</div>` : ''}
        <a href="${roomUrl}" target="_blank" class="open-link">Chatworkで開く →</a>
      </div>
    `;
  }).join('');
}

// --- Main ---

async function analyze() {
  const hoursBack = parseInt(periodEl.value, 10);

  // 入力欄に値があれば自動保存してから使う
  const inputToken = cwTokenEl.value.trim();
  const inputClaudeKey = claudeKeyEl.value.trim();
  if (inputToken) {
    await new Promise(resolve =>
      chrome.storage.local.set({ cwToken: inputToken, claudeKey: inputClaudeKey, period: periodEl.value }, resolve)
    );
  }

  const { cwToken: token, claudeKey } = await new Promise(resolve =>
    chrome.storage.local.get(['cwToken', 'claudeKey'], resolve)
  );

  if (!token) {
    showError('ChatworkのAPIトークンを入力してください。右上の ⚙ から設定できます。');
    return;
  }

  analyzeBtn.disabled = true;
  btnLabel.textContent = '分析中...';
  resultsEl.innerHTML = '';
  summaryEl.classList.add('hidden');

  try {
    setStatus('自分のアカウント情報を取得中...', 5);
    const me = await cwFetch('/me', token);
    const myAccountId = me.account_id;

    setStatus('ルーム一覧を取得中...', 10);
    const rooms = await cwFetch('/rooms', token);

    const cutoffSec = Math.floor(Date.now() / 1000) - hoursBack * 3600;

    // Tier 1: rooms with unread mentions (mention_num > 0) — always check
    // Tier 2: active rooms in period with unread messages — check if no Tier 1 or for wider coverage
    const mentionRooms = rooms.filter(r => r.mention_num > 0);
    const otherActiveRooms = rooms.filter(
      r => r.mention_num === 0 && r.unread_num > 0 && r.last_update_time >= cutoffSec
    );

    const targetRooms = [
      ...mentionRooms,
      ...otherActiveRooms,
    ];

    if (targetRooms.length === 0) {
      setStatus('チェック対象のルームがありません', 100);
      renderResults([]);
      return;
    }

    const candidates = [];

    for (let i = 0; i < targetRooms.length; i++) {
      const room = targetRooms[i];
      const progress = 10 + Math.round((i / targetRooms.length) * 65);
      const tier = room.mention_num > 0 ? `★ ` : '';
      setStatus(`${i + 1}/${targetRooms.length}: ${tier}${room.name} をチェック中...`, progress);

      try {
        const messages = await cwFetch(`/rooms/${room.room_id}/messages?force=1`, token);

        for (const msg of messages) {
          const isFromMe = String(msg.account.account_id) === String(myAccountId);
          const isRecent = msg.send_time >= cutoffSec;
          const mentioned = isMentionedInBody(msg.body, myAccountId);

          if (!isFromMe && isRecent && mentioned) {
            candidates.push({
              room,
              msg,
              mentionType: getMentionType(msg.body, myAccountId),
              reason: null,
            });
          }
        }
      } catch (e) {
        console.warn(`ルーム "${room.name}" の取得に失敗:`, e);
      }

      // Rate limit buffer: ~200ms between requests (max 300 req/min safe)
      await new Promise(r => setTimeout(r, 200));
    }

    let finalItems = candidates;

    if (claudeKey && candidates.length > 0) {
      const batchCount = Math.ceil(candidates.length / CLAUDE_BATCH_SIZE);
      for (let b = 0; b < batchCount; b++) {
        const from = b * CLAUDE_BATCH_SIZE;
        const to = Math.min(from + CLAUDE_BATCH_SIZE, candidates.length);
        setStatus(
          `AI分析中... (${to}/${candidates.length}件)`,
          75 + Math.round((b / batchCount) * 20)
        );
        try {
          const batch = candidates.slice(from, to);
          const batchResults = await classifyBatch(claudeKey, batch);
          for (const r of batchResults) {
            if (candidates[from + r.index]) {
              candidates[from + r.index].reason = r.reason || null;
              candidates[from + r.index]._needsReply = r.needs_reply;
            }
          }
        } catch (e) {
          console.error('Claude API batch error:', e);
          setStatus('AI分析に失敗しました。メンション一覧を表示します。', 75);
          break;
        }
      }

      // If Claude responded, filter to only needs_reply=true
      // (if _needsReply is undefined, AI didn't respond → keep the item)
      finalItems = candidates.filter(c => c._needsReply !== false);
    }

    setStatus('完了', 100);

    const aiNote = claudeKey ? 'AI判定済み' : 'メンション検出のみ';
    const mentionNote = mentionRooms.length > 0
      ? `(未読メンションあり: ${mentionRooms.length}ルーム)`
      : '';
    summaryText.textContent = `${finalItems.length}件のメッセージ — ${aiNote} ${mentionNote}`;
    summaryEl.classList.remove('hidden');

    renderResults(finalItems);

  } catch (e) {
    showError(e.message);
    progressBar.style.width = '0%';
  } finally {
    analyzeBtn.disabled = false;
    btnLabel.textContent = '🔍 分析開始';
  }
}

// --- Events ---

settingsToggle.addEventListener('click', () => {
  settingsEl.classList.toggle('hidden');
});

saveSettingsBtn.addEventListener('click', saveSettings);
clearSettingsBtn.addEventListener('click', clearSettings);
analyzeBtn.addEventListener('click', analyze);

// 表示/非表示トグル
document.querySelectorAll('.toggle-visibility').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;
    const isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';
    btn.textContent = isHidden ? '🙈' : '👁';
  });
});

loadSettings();
