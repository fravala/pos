// Panel SUPERADMIN — gestión de empresas (tenants) de toda la plataforma
import { getSessionValue, setSessionValue } from './db.js';
import { phpPost } from './api.js';

const PHP_API_BASE = window.__ENV__?.PHP_API_BASE || 'http://localhost:8000/api';

function el(id) { return document.getElementById(id); }
const money = (n) => `$${Number(n).toFixed(2)}`;

async function phpGet(endpoint) {
  const token = await getSessionValue('jwt');
  const res = await fetch(`${PHP_API_BASE}/${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error((await res.json()).error || 'Error de red');
  return res.json();
}

export async function enterSuperAdmin(session) {
  el('superadmin-user-label').textContent = `${session.user.username} (SUPERADMIN)`;
  document.getElementById('screen-login').classList.add('hidden');
  document.getElementById('screen-superadmin').classList.remove('hidden');
  document.getElementById('screen-superadmin').classList.add('flex');
  await loadTenants();
}

async function loadTenants() {
  const tenants = await phpGet('tenants_manage.php?action=list');
  renderTenants(tenants);
}

function renderTenants(tenants) {
  const wrap = el('tenants-list');
  wrap.innerHTML = '';

  if (!tenants.length) {
    wrap.innerHTML = `<div class="text-center text-slate-400 py-16">No hay empresas todavía. Crea la primera.</div>`;
    return;
  }

  tenants.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'bg-white rounded-xl p-4 border border-slate-200 shadow-sm flex items-center gap-4';
    row.innerHTML = `
      <div class="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
        <span class="material-symbols-outlined">storefront</span>
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <h4 class="font-bold text-slate-800 truncate">${t.name}</h4>
          ${t.status === 'DISABLED' ? `<span class="text-[10px] font-bold uppercase bg-slate-200 text-slate-500 px-2 py-0.5 rounded-full">Desactivada</span>` : ''}
        </div>
        <p class="text-xs text-slate-400">${t.location_count} ${t.location_count == 1 ? 'sucursal' : 'sucursales'} · ${t.user_count} ${t.user_count == 1 ? 'usuario' : 'usuarios'}</p>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <button class="btn-detail p-2 rounded-lg text-slate-400 hover:bg-secondary/10 hover:text-secondary transition-colors" title="Ver detalle">
          <span class="material-symbols-outlined text-lg">visibility</span>
        </button>
        <button class="btn-rename p-2 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-primary transition-colors" title="Renombrar">
          <span class="material-symbols-outlined text-lg">edit</span>
        </button>
        <button class="btn-toggle-status p-2 rounded-lg text-slate-400 hover:bg-slate-100 transition-colors ${t.status === 'DISABLED' ? 'hover:text-success' : 'hover:text-red-500'}" title="${t.status === 'DISABLED' ? 'Activar' : 'Desactivar'}">
          <span class="material-symbols-outlined text-lg">${t.status === 'DISABLED' ? 'toggle_off' : 'toggle_on'}</span>
        </button>
      </div>`;

    row.querySelector('.btn-detail').addEventListener('click', () => openTenantDetail(t));
    row.querySelector('.btn-rename').addEventListener('click', () => openRenameModal(t));
    row.querySelector('.btn-toggle-status').addEventListener('click', async () => {
      const newStatus = t.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED';
      const msg = newStatus === 'DISABLED'
        ? `¿Desactivar "${t.name}"? Ningún usuario de esta empresa podrá iniciar sesión.`
        : `¿Activar "${t.name}" de nuevo?`;
      if (!confirm(msg)) return;
      try {
        await phpPost('tenants_manage.php?action=toggle_status', { tenant_id: t.id, status: newStatus });
        await loadTenants();
      } catch (err) {
        alert(err.message || 'Error al cambiar el estado');
      }
    });

    wrap.appendChild(row);
  });
}

// ============================================================
// CREAR EMPRESA
// ============================================================
el('btn-new-tenant')?.addEventListener('click', () => {
  el('form-tenant').reset();
  el('tenant-form-error').classList.add('hidden');
  el('modal-tenant').classList.remove('hidden');
  el('modal-tenant').classList.add('flex');
});

el('btn-tenant-cancel')?.addEventListener('click', () => {
  el('modal-tenant').classList.add('hidden');
  el('modal-tenant').classList.remove('flex');
});

el('form-tenant')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  el('tenant-form-error').classList.add('hidden');
  try {
    await phpPost('tenants_manage.php?action=create', {
      tenant_name: el('tenant-name').value.trim(),
      location_name: el('tenant-location-name').value.trim(),
      admin_username: el('tenant-admin-username').value.trim(),
      admin_password: el('tenant-admin-password').value,
    });
    el('modal-tenant').classList.add('hidden');
    el('modal-tenant').classList.remove('flex');
    await loadTenants();
  } catch (err) {
    el('tenant-form-error').textContent = err.message || 'Error al crear la empresa';
    el('tenant-form-error').classList.remove('hidden');
  }
});

// ============================================================
// DETALLE DE EMPRESA (sucursales, usuarios, ventas)
// ============================================================
const roleLabel = { ADMIN: 'Administrador', CASHIER: 'Cajero', KITCHEN: 'Cocina', SUPERADMIN: 'Superadmin' };

async function openTenantDetail(tenant) {
  el('tenant-detail-name').textContent = tenant.name;
  el('tenant-detail-sales').innerHTML = '';
  el('tenant-detail-chart').innerHTML = '';
  el('tenant-detail-top-products').innerHTML = '';
  el('tenant-detail-locations').innerHTML = '';
  el('tenant-detail-users').innerHTML = '';

  el('modal-tenant-detail').classList.remove('hidden');
  el('modal-tenant-detail').classList.add('flex');

  try {
    const data = await phpGet(`tenants_manage.php?action=detail&tenant_id=${tenant.id}`);
    renderTenantDetail(data);
  } catch (err) {
    el('tenant-detail-locations').innerHTML = `<p class="text-red-500 text-sm">${err.message || 'Error al cargar el detalle'}</p>`;
  }
}

function renderTenantDetail(data) {
  const s = data.sales;
  el('tenant-detail-sales').innerHTML = `
    <div class="bg-slate-50 rounded-xl p-3 border border-slate-200">
      <p class="text-xs text-slate-400 uppercase tracking-wide mb-1">Hoy</p>
      <p class="text-xl font-black text-slate-900">${money(s.today_total)}</p>
      <p class="text-xs text-slate-400">${s.today_count} órdenes</p>
    </div>
    <div class="bg-slate-50 rounded-xl p-3 border border-slate-200">
      <p class="text-xs text-slate-400 uppercase tracking-wide mb-1">Últimos 7 días</p>
      <p class="text-xl font-black text-slate-900">${money(s.week_total)}</p>
      <p class="text-xs text-slate-400">${s.week_count} órdenes</p>
    </div>`;

  const dayLabels = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const dailyMap = {};
  (data.daily || []).forEach((d) => { dailyMap[d.day] = Number(d.total); });
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const maxTotal = Math.max(...days.map((k) => dailyMap[k] || 0), 1);
  const chartWrap = el('tenant-detail-chart');
  if (!(data.daily || []).length) {
    chartWrap.innerHTML = `<p class="text-sm text-slate-400 m-auto">Sin ventas en los últimos 7 días.</p>`;
  } else {
    chartWrap.innerHTML = days.map((k) => {
      const value = dailyMap[k] || 0;
      const heightPct = Math.max((value / maxTotal) * 100, value > 0 ? 4 : 0);
      const dow = new Date(k + 'T00:00:00').getDay();
      return `
        <div class="flex-1 flex flex-col items-center justify-end h-full gap-1">
          <span class="text-[10px] text-slate-500 font-semibold">${value > 0 ? money(value) : ''}</span>
          <div class="w-full bg-primary rounded-t-md" style="height: ${heightPct}%; min-height: ${value > 0 ? '4px' : '0'}"></div>
          <span class="text-[10px] text-slate-400">${dayLabels[dow]}</span>
        </div>`;
    }).join('');
  }

  const topWrap = el('tenant-detail-top-products');
  if (!(data.top_products || []).length) {
    topWrap.innerHTML = `<p class="text-sm text-slate-400">Sin ventas en los últimos 7 días.</p>`;
  } else {
    topWrap.innerHTML = data.top_products.map((p) => `
      <div class="bg-slate-50 rounded-lg p-3 flex items-center justify-between text-sm">
        <span class="font-semibold text-slate-700">${p.name}</span>
        <span class="text-slate-500">${p.qty} uds · <strong class="text-slate-900">${money(p.revenue)}</strong></span>
      </div>`).join('');
  }

  const locWrap = el('tenant-detail-locations');
  if (!data.locations.length) {
    locWrap.innerHTML = `<p class="text-sm text-slate-400">Sin sucursales.</p>`;
  } else {
    locWrap.innerHTML = data.locations.map((l) => `
      <div class="bg-slate-50 rounded-lg p-3 text-sm font-semibold text-slate-700">${l.name}</div>
    `).join('');
  }

  const usersWrap = el('tenant-detail-users');
  usersWrap.innerHTML = '';
  if (!data.users.length) {
    usersWrap.innerHTML = `<p class="text-sm text-slate-400">Sin usuarios.</p>`;
    return;
  }

  data.users.forEach((u) => {
    const row = document.createElement('div');
    row.className = 'bg-slate-50 rounded-lg p-3 flex items-center justify-between text-sm';
    row.innerHTML = `
      <div class="flex items-center gap-2 min-w-0">
        <span class="font-semibold text-slate-700 truncate">${u.username}</span>
        <span class="text-slate-500 shrink-0">${roleLabel[u.role] || u.role}</span>
        ${u.status === 'DISABLED' ? `<span class="text-[10px] font-bold uppercase bg-slate-200 text-slate-500 px-2 py-0.5 rounded-full shrink-0">Desactivado</span>` : ''}
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <button class="btn-user-reset p-1.5 rounded-lg text-slate-400 hover:bg-slate-200 hover:text-primary transition-colors" title="Restablecer contraseña">
          <span class="material-symbols-outlined text-base">lock_reset</span>
        </button>
        <button class="btn-user-toggle p-1.5 rounded-lg text-slate-400 hover:bg-slate-200 transition-colors ${u.status === 'DISABLED' ? 'hover:text-success' : 'hover:text-red-500'}" title="${u.status === 'DISABLED' ? 'Activar' : 'Desactivar'}">
          <span class="material-symbols-outlined text-base">${u.status === 'DISABLED' ? 'toggle_off' : 'toggle_on'}</span>
        </button>
      </div>`;

    row.querySelector('.btn-user-reset').addEventListener('click', () => openUserResetModal(u));
    row.querySelector('.btn-user-toggle').addEventListener('click', async () => {
      const newStatus = u.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED';
      if (!confirm(`¿${newStatus === 'ACTIVE' ? 'Activar' : 'Desactivar'} a "${u.username}"?`)) return;
      try {
        await phpPost('users_manage.php?action=toggle_status', { user_id: u.id, status: newStatus });
        u.status = newStatus;
        renderTenantDetail(data);
      } catch (err) {
        alert(err.message || 'Error al cambiar el estado');
      }
    });

    usersWrap.appendChild(row);
  });
}

let resetTargetUser = null;

function openUserResetModal(user) {
  resetTargetUser = user;
  el('tenant-user-reset-username').textContent = user.username;
  el('form-tenant-user-reset').reset();
  el('modal-tenant-user-reset').classList.remove('hidden');
  el('modal-tenant-user-reset').classList.add('flex');
}

el('btn-tenant-user-reset-cancel')?.addEventListener('click', () => {
  el('modal-tenant-user-reset').classList.add('hidden');
  el('modal-tenant-user-reset').classList.remove('flex');
});

el('form-tenant-user-reset')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await phpPost('users_manage.php?action=reset_password', {
      user_id: resetTargetUser.id,
      new_password: el('tenant-user-reset-new').value,
    });
    el('modal-tenant-user-reset').classList.add('hidden');
    el('modal-tenant-user-reset').classList.remove('flex');
    alert(`Contraseña de "${resetTargetUser.username}" actualizada.`);
  } catch (err) {
    alert(err.message || 'Error al restablecer la contraseña');
  }
});

el('btn-tenant-detail-close')?.addEventListener('click', () => {
  el('modal-tenant-detail').classList.add('hidden');
  el('modal-tenant-detail').classList.remove('flex');
});

// ============================================================
// RENOMBRAR EMPRESA
// ============================================================
let renamingTenant = null;

function openRenameModal(tenant) {
  renamingTenant = tenant;
  el('tenant-rename-name').value = tenant.name;
  el('modal-tenant-rename').classList.remove('hidden');
  el('modal-tenant-rename').classList.add('flex');
}

el('btn-tenant-rename-cancel')?.addEventListener('click', () => {
  el('modal-tenant-rename').classList.add('hidden');
  el('modal-tenant-rename').classList.remove('flex');
});

el('form-tenant-rename')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await phpPost('tenants_manage.php?action=update', {
      tenant_id: renamingTenant.id,
      name: el('tenant-rename-name').value.trim(),
    });
    el('modal-tenant-rename').classList.add('hidden');
    el('modal-tenant-rename').classList.remove('flex');
    await loadTenants();
  } catch (err) {
    alert(err.message || 'Error al renombrar');
  }
});

// ============================================================
// LOGOUT
// ============================================================
el('btn-superadmin-logout')?.addEventListener('click', async () => {
  await setSessionValue('jwt', null);
  await setSessionValue('user', null);
  location.reload();
});
