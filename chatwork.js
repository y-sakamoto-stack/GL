const CW_API = 'https://api.chatwork.com/v2';
const CLAUDE_API = 'https://api.anthropic.com/v1/messages';

const cwTokenEl = document.getElementById('cw-token');
const claudeKeyEl = document.getElementById('claude-key');
const periodEl = document.getElementById('period');
const settingsEl = document.getElementById('settings');
const settingsToggle = document.getElementById('settings-toggle');
const saveSettingsBtn = document.getElementById('save-settings');
const analyzeBtn = document.getElementById('analyze-btn');
const btnLabel = document.getElementById('btn-label');
const statusBar = document.getElementById('status-bar');
const statusText = document.getElementById('status-text');
const progressBar = document.getElementById('progress-bar');
const summaryEl = document.getElementById('summary');
const summaryText = document.getElementById('summary-text');
const resultsEl = document.getElementById('results');

// --- Storage ---

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('cw_settings') || '{}');
    if (s.cwToken) cwTokenEl.value = s.cwToken;
    if (s.claudeKey) claudeKeyEl.value = s.claudeKey;
    if (s.period) periodEl.value = s.period;
  } catch (_) {}
}

function saveSettings() {
  localStorage.setItem('cw_settings', JSON.stringify({
    cwToken: cwTokenEl.value,
    claudeKey: claudeKeyEl.value,
    period: periodEl.value,
  }));
  settingsEl.classList.add('hidden');
  setStatus('設定を保存しました', 100);
}

// --- Chatwork API ---

async function cwFetch(path, token) {
  const res = await fetch(`${CW_API}${path}`, {
    headers: { 'X-ChatWorkToken': token },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Chatwork API エラー (${res.status})${body ? ': ' + body : ''}`);
  }
  return res.json();
}

// --- Claude API ---

async function classifyWithClaude(claudeKey, candidates) {
  const items = candidates.map((c, i) => {
    const body = c.msg.body.replace(/\[.*?\]/g, '').trim().slice(0, 400);
    return `[${i}] 送信者: ${c.msg.account.name}\nルーム: ${c.room.name}\nメッセージ:\n${body}`;
  }).join('\n---\n');

  const prompt = `以下のChatworkメッセージのうち、あなた(受信者)が返信または対応すべきものを判定してください。

${items}

判定基準:
- 返信必要: 質問・依頼・確認依頼・レビュー依頼・タスク依頼・承認依頼など
- 返信不要: 単なる情報共有・完了報告・挨拶のみ・スタンプ類

各メッセージについてJSON配列で返してください。他のテキストは不要です。
[{"index": 0, "needs_reply": true, "reason": "〇〇の依頼のため"}, ...]`;

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

// --- UI helpers ---

function setStatus(msg, progress = null) {
  statusText.textContent = msg;
  statusBar.classList.remove('hidden');
  if (progress !== null) {
    progressBar.style.width = `${progress}%`;
  }
}

function showError(msg) {
  resultsEl.innerHTML = `<div class="error-msg">${escapeHtml(msg)}</div>`;
}

function escapeHtml(str) {
  return str
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
  return d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function renderResults(items) {
  if (items.length === 0) {
    resultsEl.innerHTML = '<div class="empty">返信が必要なメッセージはありません 🎉</div>';
    return;
  }

  resultsEl.innerHTML = items.map(({ room, msg, reason }) => {
    const body = msg.body
      .replace(/\[To:\d+\]/g, '')
      .replace(/\[toall\]/g, '')
      .trim();
    const preview = body.slice(0, 200) + (body.length > 200 ? '…' : '');
    const roomUrl = `https://www.chatwork.com/#!rid${room.room_id}`;

    return `
      <div class="message-card">
        <div class="card-header">
          <span class="room-name" title="${escapeHtml(room.name)}">${escapeHtml(room.name)}</span>
          <span class="mention-badge">TO あり</span>
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
  const token = cwTokenEl.value.trim();
  const claudeKey = claudeKeyEl.value.trim();
  const hoursBack = parseInt(periodEl.value, 10);

  if (!token) {
    showError('ChatworkのAPIトークンを入力してください。右上の⚙から設定できます。');
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

    setStatus('ルーム一覧を取得中...', 15);
    const rooms = await cwFetch('/rooms', token);

    const cutoffSec = Math.floor(Date.now() / 1000) - hoursBack * 3600;
    const activeRooms = rooms.filter(r => r.last_update_time >= cutoffSec);

    const candidates = [];

    for (let i = 0; i < activeRooms.length; i++) {
      const room = activeRooms[i];
      const progress = 15 + Math.round((i / activeRooms.length) * 60);
      setStatus(`${i + 1}/${activeRooms.length}: ${room.name} をチェック中...`, progress);

      try {
        const messages = await cwFetch(`/rooms/${room.room_id}/messages?force=1`, token);
        const mentionPattern = `[To:${myAccountId}]`;
        const toAll = '[toall]';

        for (const msg of messages) {
          const isFromMe = msg.account.account_id === myAccountId;
          const isRecent = msg.send_time >= cutoffSec;
          const hasMention = msg.body.includes(mentionPattern) || msg.body.includes(toAll);

          if (!isFromMe && isRecent && hasMention) {
            candidates.push({ room, msg });
          }
        }
      } catch (e) {
        console.warn(`ルーム ${room.name} の取得に失敗:`, e);
      }

      await new Promise(r => setTimeout(r, 80));
    }

    let finalItems = candidates.map(c => ({ ...c, reason: null }));

    if (claudeKey && candidates.length > 0) {
      setStatus(`${candidates.length}件をAIで分析中...`, 80);
      try {
        const classifications = await classifyWithClaude(claudeKey, candidates);
        const needsReplySet = new Set(
          classifications.filter(c => c.needs_reply).map(c => c.index)
        );
        const reasonMap = Object.fromEntries(
          classifications.map(c => [c.index, c.reason])
        );

        finalItems = candidates
          .map((c, i) => ({ ...c, reason: reasonMap[i] || null }))
          .filter((_, i) => needsReplySet.has(i));
      } catch (e) {
        setStatus('AI分析に失敗しました。メンション一覧を表示します。', 80);
        console.error('Claude API error:', e);
      }
    }

    setStatus('完了', 100);

    const aiNote = claudeKey ? '（AI判定済み）' : '（メンションのみ抽出）';
    summaryText.textContent = `${finalItems.length}件のメッセージ ${aiNote}`;
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
analyzeBtn.addEventListener('click', analyze);

loadSettings();
