// Checklists de apertura y cierre — CRUD de ítems (Configuración) + ejecución (abrir/cerrar turno)
import { getSessionValue } from './db.js';
import { supabaseGet, supabasePost, supabaseDelete } from './api.js';

const PHP_API_BASE = window.__ENV__?.PHP_API_BASE || 'http://localhost:8000/api';

function el(id) { return document.getElementById(id); }

async function phpGet(endpoint) {
  const token = await getSessionValue('jwt');
  const res = await fetch(`${PHP_API_BASE}/${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error((await res.json()).error || 'Error de red');
  return res.json();
}

let locationId = null;
let items = { OPENING: [], CLOSING: [] };
let usersById = {};

async function resolveLocationId() {
  if (locationId) return locationId;
  const user = await getSessionValue('user');
  if (!user) return null;
  locationId = user.location_id
    ? user.location_id
    : (await supabaseGet(`locations?tenant_id=eq.${user.tenant_id}&select=id&limit=1`))[0]?.id;
  return locationId;
}

async function loadUsersForAssignment() {
  try {
    const rows = await phpGet('users_manage.php?action=list');
    usersById = Object.fromEntries(rows.map((u) => [u.id, u.username]));
    const options = '<option value="">Cualquiera</option>' +
      rows.map((u) => `<option value="${u.id}">${u.username}</option>`).join('');
    document.querySelectorAll('.checklist-add-assignee').forEach((sel) => { sel.innerHTML = options; });
  } catch {
    // sin permisos o error de red: se queda con "Cualquiera" únicamente
  }
}

// ============================================================
// CONFIGURACIÓN — CRUD de ítems por sucursal
// ============================================================
export async function loadChecklistSettings() {
  const id = await resolveLocationId();
  if (!id) return;

  await loadUsersForAssignment();

  const rows = await supabaseGet(`checklist_templates?location_id=eq.${id}&active=eq.true&order=sort_order.asc`);
  items.OPENING = rows.filter((r) => r.type === 'OPENING');
  items.CLOSING = rows.filter((r) => r.type === 'CLOSING');
  renderChecklistSettingsList('OPENING');
  renderChecklistSettingsList('CLOSING');
}

function renderChecklistSettingsList(type) {
  const wrap = el(type === 'OPENING' ? 'checklist-opening-list' : 'checklist-closing-list');
  if (!items[type].length) {
    wrap.innerHTML = `<p class="text-sm text-slate-400">Sin ítems todavía.</p>`;
    return;
  }
  wrap.innerHTML = items[type].map((item) => `
    <div class="flex items-center justify-between bg-slate-50 rounded-lg px-3 py-2 text-sm" data-id="${item.id}">
      <span class="text-slate-700">
        ${item.label}
        ${item.assigned_user_id ? `<span class="text-xs text-primary font-semibold ml-1">(${usersById[item.assigned_user_id] || 'usuario'})</span>` : ''}
      </span>
      <button class="btn-checklist-delete text-slate-400 hover:text-red-500 transition-colors" data-id="${item.id}">
        <span class="material-symbols-outlined text-lg">delete</span>
      </button>
    </div>`).join('');

  wrap.querySelectorAll('.btn-checklist-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await supabaseDelete(`checklist_templates?id=eq.${btn.dataset.id}`);
      await loadChecklistSettings();
    });
  });
}

document.querySelectorAll('.checklist-add-form').forEach((form) => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const type = form.dataset.type;
    const input = form.querySelector('.checklist-add-input');
    const assigneeSelect = form.querySelector('.checklist-add-assignee');
    const label = input.value.trim();
    if (!label) return;
    const id = await resolveLocationId();
    const user = await getSessionValue('user');
    const sortOrder = items[type].length;
    await supabasePost('checklist_templates', {
      tenant_id: user.tenant_id,
      location_id: id,
      type,
      label,
      sort_order: sortOrder,
      assigned_user_id: assigneeSelect.value || null,
    });
    input.value = '';
    assigneeSelect.value = '';
    await loadChecklistSettings();
  });
});

// ============================================================
// EJECUCIÓN — se muestra al abrir turno / hacer Corte Z
// Solo se muestran ítems sin asignar ("Cualquiera") o asignados al usuario
// que tiene la sesión abierta en este momento.
// ============================================================
export async function runChecklist(type, cashSessionId = null) {
  const id = await resolveLocationId();
  const user = await getSessionValue('user');
  if (!id) return;

  const allItems = items[type]?.length
    ? items[type]
    : (await supabaseGet(`checklist_templates?location_id=eq.${id}&type=eq.${type}&active=eq.true&order=sort_order.asc`));

  const templateItems = allItems.filter((item) => !item.assigned_user_id || item.assigned_user_id === user.id);

  if (!templateItems.length) return; // sin ítems configurados/asignados a este usuario: no interrumpe el flujo

  const checked = await new Promise((resolve) => {
    el('checklist-run-title').textContent = type === 'OPENING' ? 'Checklist de apertura' : 'Checklist de cierre';
    el('checklist-run-items').innerHTML = templateItems.map((item, i) => `
      <label class="flex items-center gap-3 bg-slate-50 rounded-lg px-3 py-2.5">
        <input type="checkbox" class="checklist-run-checkbox w-5 h-5 rounded border-slate-300 text-primary focus:ring-primary" data-index="${i}">
        <span class="text-sm text-slate-700">${item.label}</span>
      </label>`).join('');

    el('modal-checklist-run').classList.remove('hidden');
    el('modal-checklist-run').classList.add('flex');

    const onContinue = () => {
      const boxes = [...document.querySelectorAll('.checklist-run-checkbox')];
      const result = boxes.map((b, i) => ({ label: templateItems[i].label, checked: b.checked }));
      const pending = result.filter((r) => !r.checked).length;
      if (pending > 0 && !confirm(`Faltan ${pending} ítem(s) sin marcar. ¿Continuar de todos modos?`)) return;

      el('modal-checklist-run').classList.add('hidden');
      el('modal-checklist-run').classList.remove('flex');
      el('btn-checklist-run-continue').removeEventListener('click', onContinue);
      resolve(result);
    };
    el('btn-checklist-run-continue').addEventListener('click', onContinue);
  });

  try {
    await supabasePost('checklist_runs', {
      tenant_id: user.tenant_id,
      location_id: id,
      type,
      cash_session_id: cashSessionId,
      completed_by: user.id,
      items: checked,
      all_checked: checked.every((r) => r.checked),
    });
  } catch {
    // si falla el registro de auditoría no se bloquea el flujo de apertura/cierre
  }
}
