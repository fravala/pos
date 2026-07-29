// Checklists de apertura/cierre para KDS — versión reducida (solo ejecución, sin CRUD).
// KDS vive en su propio subdominio con su propia sesión (localStorage), no comparte
// IndexedDB con el POS, por eso este módulo es independiente de frontend/pos/js/checklist.js.
const PHP_API_BASE = window.__ENV__?.PHP_API_BASE || 'http://localhost:8000/api';
const SUPABASE_URL = window.__ENV__?.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = window.__ENV__?.SUPABASE_ANON_KEY || '';

function el(id) { return document.getElementById(id); }
function getToken() { return localStorage.getItem('kds_jwt') || ''; }
function getUser() {
  const raw = localStorage.getItem('kds_user');
  return raw ? JSON.parse(raw) : null;
}

async function supabaseGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw new Error('Error consultando Supabase');
  return res.json();
}

async function supabasePost(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${getToken()}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Error escribiendo en Supabase');
  return res.json();
}

let locationId = null;
let items = { OPENING: [], CLOSING: [] };

async function resolveLocationId() {
  if (locationId) return locationId;
  const user = getUser();
  if (!user) return null;
  locationId = user.location_id
    ? user.location_id
    : (await supabaseGet(`locations?tenant_id=eq.${user.tenant_id}&select=id&limit=1`))[0]?.id;
  return locationId;
}

async function getTodayRun(type) {
  const id = await resolveLocationId();
  if (!id) return null;
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const rows = await supabaseGet(
    `checklist_runs?location_id=eq.${id}&type=eq.${type}&created_at=gte.${startOfDay.toISOString()}&order=created_at.desc&limit=1&select=*`
  );
  return rows[0] || null;
}

async function isChecklistDoneToday(type) {
  const run = await getTodayRun(type);
  return !!run?.all_checked;
}

export async function runChecklist(type) {
  const id = await resolveLocationId();
  const user = getUser();
  if (!id || !user) return;

  const allItems = items[type]?.length
    ? items[type]
    : (await supabaseGet(`checklist_templates?location_id=eq.${id}&type=eq.${type}&active=eq.true&order=sort_order.asc`));
  items[type] = allItems;

  const today = new Date().getDay();
  const templateItems = allItems.filter((item) =>
    (!item.assigned_user_id || item.assigned_user_id === user.id) &&
    (!item.days_of_week?.length || item.days_of_week.includes(today))
  );

  if (!templateItems.length) return;

  const previousRun = await getTodayRun(type);
  const previousChecked = new Set((previousRun?.items || []).filter((r) => r.checked).map((r) => r.label));

  const checked = await new Promise((resolve) => {
    el('checklist-run-title').textContent = type === 'OPENING' ? 'Checklist de apertura' : 'Checklist de cierre';
    el('checklist-run-items').innerHTML = templateItems.map((item, i) => `
      <label class="flex items-center gap-3 bg-zinc-800 rounded-lg px-3 py-2.5">
        <input type="checkbox" class="checklist-run-checkbox w-5 h-5 rounded border-zinc-600 text-primary focus:ring-primary" data-index="${i}" ${previousChecked.has(item.label) ? 'checked' : ''}>
        <span class="text-sm text-zinc-200">${item.label}</span>
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
      cash_session_id: null,
      completed_by: user.id,
      items: checked,
      all_checked: checked.every((r) => r.checked),
    });
  } catch {
    // si falla el registro de auditoría no se bloquea el flujo
  }

  if (type === 'CLOSING') await updateClosingChecklistIndicator();
}

export async function maybeShowOpeningChecklistOnLogin() {
  if (await isChecklistDoneToday('OPENING')) return;
  await runChecklist('OPENING');
}

export async function updateClosingChecklistIndicator() {
  const dot = el('closing-checklist-pending-dot');
  if (!dot) return;
  const done = await isChecklistDoneToday('CLOSING');
  dot.classList.toggle('hidden', done);
}
