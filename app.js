import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://xwlqdeewhmakqevwgzfs.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3bHFkZWV3aG1ha3FldndnemZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1NTc4MjIsImV4cCI6MjA5NjEzMzgyMn0.enHhuR1zOjzMthZju8FZkbHV0qPoJJNX7BcD_rLSPzA';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let allDeals = [];
let editingId = null;

const tbody = document.getElementById('deals-body');
const modal = document.getElementById('modal');
const form = document.getElementById('deal-form');
const addBtn = document.getElementById('add-btn');
const cancelBtn = document.getElementById('modal-cancel');
const filterStatus = document.getElementById('filter-status');
const filterPriority = document.getElementById('filter-priority');
const filterSearch = document.getElementById('filter-search');
const countLabel = document.getElementById('count-label');

async function loadDeals() {
  const { data, error } = await supabase
    .from('deals')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="9" class="error">読み込みエラー: ${error.message}</td></tr>`;
    return;
  }
  allDeals = data ?? [];
  renderDeals();
}

function renderDeals() {
  const status = filterStatus.value;
  const priority = filterPriority.value;
  const search = filterSearch.value.toLowerCase();

  const filtered = allDeals.filter(d => {
    if (status && d.status !== status) return false;
    if (priority && d.priority !== priority) return false;
    if (search && !`${d.title} ${d.company ?? ''} ${d.contact_name ?? ''} ${d.assignee ?? ''}`.toLowerCase().includes(search)) return false;
    return true;
  });

  countLabel.textContent = `${filtered.length} 件`;

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">該当する商談がありません</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(d => `
    <tr data-id="${d.id}">
      <td class="title-cell">${esc(d.title)}</td>
      <td>${esc(d.company ?? '')}</td>
      <td>${esc(d.contact_name ?? '')}</td>
      <td>${esc(d.assignee ?? '')}</td>
      <td><span class="badge badge-${statusClass(d.status)}">${esc(d.status)}</span></td>
      <td><span class="badge badge-priority-${(d.priority ?? '中').toLowerCase()}">${esc(d.priority ?? '中')}</span></td>
      <td>${d.due_date ?? ''}</td>
      <td>${d.created_at ? d.created_at.slice(0, 10) : ''}</td>
      <td class="actions">
        <button class="btn btn-sm edit-btn" data-id="${d.id}">編集</button>
        <button class="btn btn-sm btn-danger delete-btn" data-id="${d.id}">削除</button>
      </td>
    </tr>
  `).join('');
}

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function statusClass(s) {
  return { '新規': 'new', '商談中': 'active', '見積中': 'quote', '成約': 'won', '失注': 'lost' }[s] ?? 'new';
}

function openModal(deal = null) {
  editingId = deal?.id ?? null;
  document.getElementById('modal-title').textContent = deal ? '商談を編集' : '商談を追加';
  form.reset();
  if (deal) {
    for (const [k, v] of Object.entries(deal)) {
      const el = form.elements[k];
      if (el && v != null) el.value = v;
    }
  }
  modal.classList.remove('hidden');
}

function closeModal() {
  modal.classList.add('hidden');
  editingId = null;
}

addBtn.addEventListener('click', () => openModal());
cancelBtn.addEventListener('click', closeModal);
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

form.addEventListener('submit', async e => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  // remove empty strings
  for (const k of Object.keys(data)) {
    if (data[k] === '') delete data[k];
  }

  let error;
  if (editingId) {
    ({ error } = await supabase.from('deals').update(data).eq('id', editingId));
  } else {
    ({ error } = await supabase.from('deals').insert(data));
  }

  if (error) {
    alert('保存エラー: ' + error.message);
    return;
  }
  closeModal();
  await loadDeals();
});

tbody.addEventListener('click', async e => {
  const id = e.target.dataset.id;
  if (!id) return;

  if (e.target.classList.contains('edit-btn')) {
    const deal = allDeals.find(d => d.id === id);
    if (deal) openModal(deal);
  }

  if (e.target.classList.contains('delete-btn')) {
    if (!confirm('この商談を削除しますか？')) return;
    const { error } = await supabase.from('deals').delete().eq('id', id);
    if (error) { alert('削除エラー: ' + error.message); return; }
    await loadDeals();
  }
});

filterStatus.addEventListener('change', renderDeals);
filterPriority.addEventListener('change', renderDeals);
filterSearch.addEventListener('input', renderDeals);

// Realtime subscription
supabase
  .channel('deals-changes')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'deals' }, () => {
    loadDeals();
  })
  .subscribe();

loadDeals();
