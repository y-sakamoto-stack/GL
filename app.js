const SUPABASE_URL = 'https://achoajdxiwjhqvovshsk.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjaG9hamR4aXdqaHF2b3ZzaHNrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg5MTExMzcsImV4cCI6MjA5NDQ4NzEzN30.o0Q7SuG2YZn5rkQwrUCUOxLHQMUwyWHxBku3pH8t77w';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let tasks = [];
let editingId = null;
let deletingId = null;

// ── Supabase CRUD ────────────────────────────────────────────────

async function loadTasks() {
  const { data, error } = await sb.from('tasks').select('*').order('created_at', { ascending: true });
  if (error) { console.error(error); return; }
  tasks = data;
  render();
}

async function createTask(payload) {
  const { error } = await sb.from('tasks').insert(payload);
  if (error) console.error(error);
}

async function updateTask(id, payload) {
  const { error } = await sb.from('tasks').update(payload).eq('id', id);
  if (error) console.error(error);
}

async function deleteTask(id) {
  const { error } = await sb.from('tasks').delete().eq('id', id);
  if (error) console.error(error);
}

// ── Real-time subscription ───────────────────────────────────────

function subscribeRealtime() {
  sb.channel('tasks-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, (payload) => {
      handleRealtimeEvent(payload);
      flashSync();
    })
    .subscribe((status) => {
      const dot = document.getElementById('sync-dot');
      dot.classList.toggle('connected', status === 'SUBSCRIBED');
    });
}

function handleRealtimeEvent({ eventType, new: newRow, old: oldRow }) {
  if (eventType === 'INSERT') {
    tasks.push(newRow);
  } else if (eventType === 'UPDATE') {
    const idx = tasks.findIndex(t => t.id === newRow.id);
    if (idx !== -1) tasks[idx] = newRow; else tasks.push(newRow);
  } else if (eventType === 'DELETE') {
    tasks = tasks.filter(t => t.id !== oldRow.id);
  }
  render();
}

function flashSync() {
  const dot = document.getElementById('sync-dot');
  dot.classList.add('flash');
  setTimeout(() => dot.classList.remove('flash'), 600);
}

// ── Render ───────────────────────────────────────────────────────

function getFiltered() {
  const search   = document.getElementById('filter-search').value.toLowerCase();
  const assignee = document.getElementById('filter-assignee').value;
  const priority = document.getElementById('filter-priority').value;
  return tasks.filter(t => {
    if (assignee && t.assignee !== assignee) return false;
    if (priority && t.priority !== priority) return false;
    if (search && !t.title.toLowerCase().includes(search) &&
        !(t.description || '').toLowerCase().includes(search)) return false;
    return true;
  });
}

function render() {
  renderBoard();
  renderStats();
  refreshAssigneeFilter();
}

function renderBoard() {
  const filtered = getFiltered();
  ['todo', 'inprogress', 'done'].forEach(status => {
    const items = filtered.filter(t => t.status === status);
    document.getElementById(`count-${status}`).textContent = items.length;
    const list = document.getElementById(`list-${status}`);
    if (items.length === 0) {
      list.innerHTML = '<div class="empty">タスクなし</div>';
      return;
    }
    list.innerHTML = items.map(taskCardHtml).join('');
    list.querySelectorAll('.task-card').forEach(card => {
      const id = card.dataset.id;
      card.querySelector('.btn-edit').addEventListener('click', e => { e.stopPropagation(); openEdit(id); });
      card.querySelector('.btn-del').addEventListener('click',  e => { e.stopPropagation(); openDelete(id); });
      card.querySelectorAll('.move-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          updateTask(id, { status: btn.dataset.to });
        });
      });
    });
  });
}

const PRIORITY_LABEL = { high: '高', medium: '中', low: '低' };
const STATUS_LABEL   = { todo: '未着手', inprogress: '進行中', done: '完了' };
const MOVE_TARGETS   = {
  todo:       [{ to: 'inprogress', label: '→ 進行中' }],
  inprogress: [{ to: 'todo', label: '← 未着手' }, { to: 'done', label: '→ 完了' }],
  done:       [{ to: 'inprogress', label: '← 進行中' }],
};

function taskCardHtml(task) {
  const avatarBg  = colorFromString(task.assignee || '');
  const avatarChr = task.assignee ? task.assignee[0] : '?';
  const dueBadge  = task.due_date ? dueDateBadge(task.due_date) : '';
  const moveBtns  = MOVE_TARGETS[task.status]
    .map(m => `<button class="move-btn" data-to="${m.to}">${m.label}</button>`)
    .join('');

  return `
    <div class="task-card priority-${task.priority}" data-id="${task.id}">
      <div class="card-top">
        <span class="badge priority-badge ${task.priority}">${PRIORITY_LABEL[task.priority]}</span>
        <div class="card-actions">
          <button class="icon-btn btn-edit" title="編集">✏️</button>
          <button class="icon-btn btn-del"  title="削除">🗑️</button>
        </div>
      </div>
      <div class="card-title">${esc(task.title)}</div>
      ${task.description ? `<div class="card-desc">${esc(task.description)}</div>` : ''}
      <div class="card-foot">
        <span class="avatar" style="background:${avatarBg}">${avatarChr}</span>
        <span class="assignee-name">${task.assignee ? esc(task.assignee) : '<em>未割当</em>'}</span>
        ${dueBadge}
      </div>
      <div class="move-actions">${moveBtns}</div>
    </div>`;
}

function dueDateBadge(dateStr) {
  const due  = new Date(dateStr);
  const now  = new Date(); now.setHours(0,0,0,0);
  const diff = Math.ceil((due - now) / 86400000);
  let cls = '';
  if (diff < 0)      cls = 'overdue';
  else if (diff <= 1) cls = 'due-soon';
  return `<span class="due-badge ${cls}">${dateStr}</span>`;
}

function renderStats() {
  const todo = tasks.filter(t => t.status === 'todo').length;
  const inpg = tasks.filter(t => t.status === 'inprogress').length;
  const done = tasks.filter(t => t.status === 'done').length;
  const pct  = tasks.length ? Math.round((done / tasks.length) * 100) : 0;

  document.getElementById('stat-todo').textContent       = todo;
  document.getElementById('stat-inprogress').textContent = inpg;
  document.getElementById('stat-done').textContent       = done;
  document.getElementById('progress-fill').style.width   = pct + '%';
  document.getElementById('progress-label').textContent  = `${pct}% 完了`;
}

function refreshAssigneeFilter() {
  const members  = [...new Set(tasks.map(t => t.assignee).filter(Boolean))].sort();
  const sel      = document.getElementById('filter-assignee');
  const current  = sel.value;
  sel.innerHTML  = '<option value="">全メンバー</option>' +
    members.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  sel.value = current;

  document.getElementById('assignee-options').innerHTML =
    members.map(m => `<option value="${esc(m)}">`).join('');
}

// ── Modal helpers ────────────────────────────────────────────────

function openAdd() {
  editingId = null;
  document.getElementById('modal-title').textContent  = 'タスク追加';
  document.getElementById('modal-submit').textContent = '追加';
  document.getElementById('task-form').reset();
  document.getElementById('f-priority').value = 'medium';
  document.getElementById('f-status').value   = 'todo';
  showOverlay('task-overlay');
  document.getElementById('f-title').focus();
}

function openEdit(id) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  editingId = id;
  document.getElementById('modal-title').textContent  = 'タスク編集';
  document.getElementById('modal-submit').textContent = '保存';
  document.getElementById('f-title').value    = t.title;
  document.getElementById('f-desc').value     = t.description || '';
  document.getElementById('f-assignee').value = t.assignee || '';
  document.getElementById('f-priority').value = t.priority;
  document.getElementById('f-status').value   = t.status;
  document.getElementById('f-due').value      = t.due_date || '';
  showOverlay('task-overlay');
  document.getElementById('f-title').focus();
}

function openDelete(id) {
  deletingId = id;
  showOverlay('del-overlay');
}

function showOverlay(id) { document.getElementById(id).classList.remove('hidden'); }
function hideOverlay(id) { document.getElementById(id).classList.add('hidden'); }

// ── Form submit ──────────────────────────────────────────────────

document.getElementById('task-form').addEventListener('submit', async e => {
  e.preventDefault();
  const payload = {
    title:       document.getElementById('f-title').value.trim(),
    description: document.getElementById('f-desc').value.trim() || null,
    assignee:    document.getElementById('f-assignee').value.trim() || null,
    priority:    document.getElementById('f-priority').value,
    status:      document.getElementById('f-status').value,
    due_date:    document.getElementById('f-due').value || null,
  };
  if (!payload.title) return;

  if (editingId) await updateTask(editingId, payload);
  else           await createTask(payload);
  hideOverlay('task-overlay');
});

document.getElementById('del-confirm').addEventListener('click', async () => {
  if (deletingId) await deleteTask(deletingId);
  hideOverlay('del-overlay');
  deletingId = null;
});

// ── Event bindings ───────────────────────────────────────────────

document.getElementById('add-task-btn').addEventListener('click', openAdd);
document.getElementById('modal-close').addEventListener('click', () => hideOverlay('task-overlay'));
document.getElementById('modal-cancel').addEventListener('click', () => hideOverlay('task-overlay'));
document.getElementById('del-cancel').addEventListener('click',  () => hideOverlay('del-overlay'));

document.getElementById('task-overlay').addEventListener('click', e => {
  if (e.target.id === 'task-overlay') hideOverlay('task-overlay');
});
document.getElementById('del-overlay').addEventListener('click', e => {
  if (e.target.id === 'del-overlay') hideOverlay('del-overlay');
});

document.getElementById('filter-search').addEventListener('input', render);
document.getElementById('filter-assignee').addEventListener('change', render);
document.getElementById('filter-priority').addEventListener('change', render);

// ── Utilities ────────────────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function colorFromString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return `hsl(${Math.abs(h) % 360},55%,45%)`;
}

// ── Boot ─────────────────────────────────────────────────────────

loadTasks();
subscribeRealtime();
