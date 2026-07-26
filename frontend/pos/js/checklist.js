// Checklists de apertura y cierre — CRUD de ítems (Configuración) + ejecución (abrir/cerrar turno)
import { getSessionValue } from './db.js';
import { supabaseGet, supabasePost, supabaseDelete } from './api.js';

function el(id) { return document.getElementById(id); }

let locationId = null;
let items = { OPENING: [], CLOSING: [] };

async function resolveLocationId() {
  if (locationId) return locationId;
  const user = await getSessionValue('user');
  if (!user) return null;
  locationId = user.location_id
    ? user.location_id
    : (await supabaseGet(`locations?tenant_id=eq.${user.tenant_id}&select=id&limit=1`))[0]?.id;
  return locationId;
}

// ============================================================
// CONFIGURACIÓN — CRUD de ítems por sucursal
// ============================================================
export async function loadChecklistSettings() {
  const id = await resolveLocationId();
  if (!id) return;

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
      <span class="text-slate-700">${item.label}</span>
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
    });
    input.value = '';
    await loadChecklistSettings();
  });
});

// ============================================================
// EJECUCIÓN — se muestra al abrir turno / hacer Corte Z
// ============================================================
export async function runChecklist(type, cashSessionId = null) {
  const id = await resolveLocationId();
  const user = await getSessionValue('user');
  if (!id) return;

  const templateItems = items[type]?.length
    ? items[type]
    : (await supabaseGet(`checklist_templates?location_id=eq.${id}&type=eq.${type}&active=eq.true&order=sort_order.asc`));

  if (!templateItems.length) return; // sin ítems configurados: no interrumpe el flujo

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
