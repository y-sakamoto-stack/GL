const CW_API = 'https://api.chatwork.com/v2';
const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const CLAUDE_BATCH_SIZE = 15;

const cwTokenEl = document.getElementById('cw-token');
const claudeKeyEl = document.getElementById('claude-key');
const periodEl = document.getElementById('period');
const contextDetectEl = document.getElementById('context-detect');
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

// --- Storage ---

function loadSettings() {
  chrome.storage.local.get(['cwToken', 'claudeKey', 'period', 'contextDetect'], (data) => {
    if (data.cwToken) cwTokenEl.value = data.cwToken;
    if (data.claudeKey) claudeKeyEl.value = data.claudeKey;
    if (data.period) periodEl.value = data.period;
    if (data.contextDetect) contextDetectEl.checked = true;
  });
}

function saveSettings() {
  const cwToken = cwTokenEl.value.trim();
  const claudeKey = claudeKeyEl.value.trim();
  if (!cwToken) {
    showError('APIトークンを入力してください。');
    return;
  }
  chrome.storage.local.set(
    { cwToken, claudeKey, period: periodEl.value, contextDetect: contextDetectEl.checked },
    () => {
      settingsEl.classList.add('hidden');
      setStatus('設定を保存しました', 100);
    }
  );
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

function cleanBody(body) {
  return body
    .replace(/\[To:\d+\]/g, '')
    .replace(/\[toall\]/g, '')
    .replace(/\[rp[^\]]*\]/g, '')
    .trim();
}

// --- Claude: 文脈から自分宛メッセージを検出 ---

async function detectContextualMessages(claudeKey, room, messages, myName, myAccountId, cutoffSec) {
  // 自分の発言を含む直近30件を会話コンテキストとして送る
  const recent = messages
    .filter(m => m.send_time >= cutoffSec)
    .slice(-30);

  if (recent.length === 0) return [];

  const conversation = recent.map(m => {
    const time = new Date(m.send_time * 1000).toLocaleString('ja-JP', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    const body = cleanBody(m.body).slice(0, 300);
    const isMe = String(m.account.account_id) === String(myAccountId);
    return `[ID:${m.message_id}][${time}] ${m.account.name}${isMe ? '（自分）' : ''}: ${body}`;
  }).join('\n');

  const prompt = `あなたはChatworkのメッセージ分析AIです。
ユーザー「${myName}」の受信トレイを確認しています。

ルーム: ${room.name}
会話（古い順）:
${conversation}

以下の条件を満たすメッセージを特定してください:
・「${myName}さん」など名前で呼びかけているメッセージ
・役職・役割（担当者、リーダーなど）で${myName}に依頼していると判断できるメッセージ
・会話の流れから${myName}が返答・対応すべき質問や依頼
・「@TO」指定がなくても文脈上${myName}宛と判断できるもの

${myName}自身が送ったメッセージ（自分）は除外してください。
@TOや[rp]で明示的にメンションされているものも除外してください（別途検出済み）。

JSON配列のみを返してください（説明不要）:
[{"message_id": "123", "needs_reply": true, "reason": "理由を簡潔に"}]
対象なし: []`;

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

  const parsed = JSON.parse(match[0]);
  // message_idに対応するmsgオブジェクトを返す
  return parsed
    .filter(r => r.needs_reply !== false)
    .map(r => {
      const msg = recent.find(m => String(m.message_id) === String(r.message_id));
      if (!msg) return null;
      return { room, msg, mentionType: 'AI', reason: r.reason || null };
    })
    .filter(Boolean);
}

// --- Claude: メンション済みメッセージの返信要否を判定 ---

async function classifyBatch(claudeKey, batch) {
  const items = batch.map((c, i) => {
    const body = cleanBody(c.msg.body).slice(0, 400);
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

const BADGE_LABEL = { TO: 'TO あり', ALL: 'toall', REPLY: 'リプライ', AI: 'AI検出' };
const BADGE_CLASS = { TO: 'badge-to', ALL: 'badge-all', REPLY: 'badge-reply', AI: 'badge-ai' };

function renderResults(items) {
  if (items.length === 0) {
    resultsEl.innerHTML = '<div class="empty">返信が必要なメッセージはありません 🎉</div>';
    return;
  }

  const sorted = [...items].sort((a, b) => b.msg.send_time - a.msg.send_time);

  resultsEl.innerHTML = sorted.map(({ room, msg, reason, mentionType }) => {
    const preview = cleanBody(msg.body).slice(0, 200);
    const hasMore = cleanBody(msg.body).length > 200;
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
        <div class="message-body">${escapeHtml(preview)}${hasMore ? '…' : ''}</div>
        ${reason ? `<div class="ai-reason">💡 ${escapeHtml(reason)}</div>` : ''}
        <a href="${roomUrl}" target="_blank" class="open-link">Chatworkで開く →</a>
      </div>
    `;
  }).join('');
}

// --- Main ---

async function analyze() {
  const hoursBack = parseInt(periodEl.value, 10);
  const useContextDetect = contextDetectEl.checked;

  // 入力欄に値があれば自動保存
  const inputToken = cwTokenEl.value.trim();
  const inputClaudeKey = claudeKeyEl.value.trim();
  if (inputToken) {
    await new Promise(resolve =>
      chrome.storage.local.set(
        { cwToken: inputToken, claudeKey: inputClaudeKey, period: periodEl.value, contextDetect: useContextDetect },
        resolve
      )
    );
  }

  const { cwToken: token, claudeKey } = await new Promise(resolve =>
    chrome.storage.local.get(['cwToken', 'claudeKey'], resolve)
  );

  if (!token) {
    showError('ChatworkのAPIトークンを入力してください。右上の ⚙ から設定できます。');
    return;
  }

  if (useContextDetect && !claudeKey) {
    showError('AI文脈検出にはClaude APIキーが必要です。⚙ から設定してください。');
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
    const myName = me.name;

    setStatus('ルーム一覧を取得中...', 10);
    const rooms = await cwFetch('/rooms', token);

    const cutoffSec = Math.floor(Date.now() / 1000) - hoursBack * 3600;

    const mentionRooms = rooms.filter(r => r.mention_num > 0);
    const otherActiveRooms = rooms.filter(
      r => r.mention_num === 0 && r.unread_num > 0 && r.last_update_time >= cutoffSec
    );
    const targetRooms = [...mentionRooms, ...otherActiveRooms];

    if (targetRooms.length === 0) {
      setStatus('チェック対象のルームがありません', 100);
      renderResults([]);
      return;
    }

    // Phase 1: メッセージ取得 & メンション検出
    const mentionCandidates = [];
    // ルームごとに取得したメッセージをキャッシュ（文脈検出で再利用）
    const roomMessages = new Map();

    for (let i = 0; i < targetRooms.length; i++) {
      const room = targetRooms[i];
      const progress = 10 + Math.round((i / targetRooms.length) * 50);
      setStatus(`${i + 1}/${targetRooms.length}: ${room.name} をチェック中...`, progress);

      try {
        const messages = await cwFetch(`/rooms/${room.room_id}/messages?force=1`, token);
        roomMessages.set(room.room_id, messages);

        for (const msg of messages) {
          const isFromMe = String(msg.account.account_id) === String(myAccountId);
          const isRecent = msg.send_time >= cutoffSec;
          const mentioned = isMentionedInBody(msg.body, myAccountId);
          if (!isFromMe && isRecent && mentioned) {
            mentionCandidates.push({
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

      await new Promise(r => setTimeout(r, 200));
    }

    // Phase 2: AI文脈検出（有効時）
    const mentionedMessageIds = new Set(mentionCandidates.map(c => String(c.msg.message_id)));
    const contextCandidates = [];

    if (useContextDetect && claudeKey) {
      const contextRooms = targetRooms.filter(r => roomMessages.has(r.room_id));

      for (let i = 0; i < contextRooms.length; i++) {
        const room = contextRooms[i];
        const progress = 60 + Math.round((i / contextRooms.length) * 25);
        setStatus(`AI文脈検出中... (${i + 1}/${contextRooms.length}: ${room.name})`, progress);

        try {
          const messages = roomMessages.get(room.room_id);
          const found = await detectContextualMessages(
            claudeKey, room, messages, myName, myAccountId, cutoffSec
          );
          // 明示的メンション済みは除外（重複防止）
          for (const item of found) {
            if (!mentionedMessageIds.has(String(item.msg.message_id))) {
              contextCandidates.push(item);
              mentionedMessageIds.add(String(item.msg.message_id));
            }
          }
        } catch (e) {
          console.warn(`ルーム "${room.name}" の文脈検出に失敗:`, e);
        }
      }
    }

    // Phase 3: メンション候補にClaudeで返信要否判定
    let finalMentionItems = mentionCandidates;

    if (claudeKey && mentionCandidates.length > 0) {
      for (let i = 0; i < mentionCandidates.length; i += CLAUDE_BATCH_SIZE) {
        const from = i;
        const to = Math.min(i + CLAUDE_BATCH_SIZE, mentionCandidates.length);
        setStatus(`メンション返信要否を判定中... (${to}/${mentionCandidates.length}件)`, 85);
        try {
          const batch = mentionCandidates.slice(from, to);
          const results = await classifyBatch(claudeKey, batch);
          for (const r of results) {
            if (mentionCandidates[from + r.index]) {
              mentionCandidates[from + r.index].reason = r.reason || null;
              mentionCandidates[from + r.index]._needsReply = r.needs_reply;
            }
          }
        } catch (e) {
          console.error('Claude classify error:', e);
          break;
        }
      }
      finalMentionItems = mentionCandidates.filter(c => c._needsReply !== false);
    }

    const finalItems = [...finalMentionItems, ...contextCandidates];

    setStatus('完了', 100);

    const parts = [];
    if (finalMentionItems.length > 0) parts.push(`メンション ${finalMentionItems.length}件`);
    if (contextCandidates.length > 0) parts.push(`AI文脈検出 ${contextCandidates.length}件`);
    summaryText.textContent = parts.length > 0
      ? `${finalItems.length}件 — ${parts.join(' / ')}`
      : '該当メッセージなし';
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
