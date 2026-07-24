// Panel ADMIN — Configuración de negocio: logo, descripción, redes, WhatsApp, horarios
import { getSessionValue } from './db.js';
import { supabaseGet, supabasePatch } from './api.js';

const DAYS = [
  ['mon', 'Lunes'], ['tue', 'Martes'], ['wed', 'Miércoles'], ['thu', 'Jueves'],
  ['fri', 'Viernes'], ['sat', 'Sábado'], ['sun', 'Domingo'],
];

let currentLocation = null;

function el(id) { return document.getElementById(id); }

function renderHoursInputs(businessHours = {}) {
  const wrap = el('settings-hours');
  wrap.innerHTML = '';
  DAYS.forEach(([key, label]) => {
    const dayHours = businessHours[key] || null;
    const row = document.createElement('div');
    row.className = 'flex items-center gap-3';
    row.innerHTML = `
      <label class="flex items-center gap-2 w-32 shrink-0">
        <input type="checkbox" class="day-enabled" data-day="${key}" ${dayHours ? 'checked' : ''}>
        <span class="text-sm">${label}</span>
      </label>
      <input type="time" class="day-open border border-slate-300 rounded-lg px-2 h-10" data-day="${key}"
        value="${dayHours?.open || '09:00'}" ${dayHours ? '' : 'disabled'}>
      <span class="text-slate-400">a</span>
      <input type="time" class="day-close border border-slate-300 rounded-lg px-2 h-10" data-day="${key}"
        value="${dayHours?.close || '18:00'}" ${dayHours ? '' : 'disabled'}>`;

    const checkbox = row.querySelector('.day-enabled');
    const openInput = row.querySelector('.day-open');
    const closeInput = row.querySelector('.day-close');
    checkbox.addEventListener('change', () => {
      openInput.disabled = !checkbox.checked;
      closeInput.disabled = !checkbox.checked;
    });

    wrap.appendChild(row);
  });
}

function collectBusinessHours() {
  const result = {};
  DAYS.forEach(([key]) => {
    const checkbox = document.querySelector(`.day-enabled[data-day="${key}"]`);
    if (checkbox && checkbox.checked) {
      const open = document.querySelector(`.day-open[data-day="${key}"]`).value;
      const close = document.querySelector(`.day-close[data-day="${key}"]`).value;
      result[key] = { open, close };
    }
  });
  return result;
}

export async function loadSettingsView() {
  const user = await getSessionValue('user');
  if (!user) return;

  const locationId = user.location_id
    ? user.location_id
    : (await supabaseGet(`locations?tenant_id=eq.${user.tenant_id}&select=id&limit=1`))[0]?.id;

  if (!locationId) return;

  const rows = await supabaseGet(`locations?id=eq.${locationId}&select=*`);
  currentLocation = rows[0];
  if (!currentLocation) return;

  el('settings-logo-url').value = currentLocation.logo_url || '';
  el('settings-whatsapp').value = currentLocation.whatsapp_number || '';
  el('settings-description').value = currentLocation.description || '';
  el('settings-cash-alert').value = currentLocation.settings?.cash_alert_threshold ?? '';
  el('settings-auto-print').checked = currentLocation.settings?.auto_print_receipt ?? true;
  el('settings-kds-enabled').checked = currentLocation.settings?.kds_enabled ?? true;

  const social = currentLocation.settings?.social || {};
  el('settings-social-facebook').value = social.facebook || '';
  el('settings-social-instagram').value = social.instagram || '';
  el('settings-social-tiktok').value = social.tiktok || '';

  renderHoursInputs(currentLocation.settings?.business_hours || {});
}

el('form-settings')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentLocation) return;

  const payload = {
    logo_url: el('settings-logo-url').value.trim() || null,
    whatsapp_number: el('settings-whatsapp').value.trim() || null,
    description: el('settings-description').value.trim() || null,
    settings: {
      ...(currentLocation.settings || {}),
      business_hours: collectBusinessHours(),
      social: {
        facebook: el('settings-social-facebook').value.trim() || null,
        instagram: el('settings-social-instagram').value.trim() || null,
        tiktok: el('settings-social-tiktok').value.trim() || null,
      },
      cash_alert_threshold: el('settings-cash-alert').value ? parseFloat(el('settings-cash-alert').value) : null,
      auto_print_receipt: el('settings-auto-print').checked,
      kds_enabled: el('settings-kds-enabled').checked,
    },
  };

  await supabasePatch(`locations?id=eq.${currentLocation.id}`, payload);
  currentLocation = { ...currentLocation, ...payload };

  const msg = el('settings-saved-msg');
  msg.classList.remove('hidden');
  setTimeout(() => msg.classList.add('hidden'), 2000);
});
