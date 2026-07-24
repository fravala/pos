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
        <button class="btn-rename p-2 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-primary transition-colors" title="Renombrar">
          <span class="material-symbols-outlined text-lg">edit</span>
        </button>
        <button class="btn-toggle-status p-2 rounded-lg text-slate-400 hover:bg-slate-100 transition-colors ${t.status === 'DISABLED' ? 'hover:text-success' : 'hover:text-red-500'}" title="${t.status === 'DISABLED' ? 'Activar' : 'Desactivar'}">
          <span class="material-symbols-outlined text-lg">${t.status === 'DISABLED' ? 'toggle_off' : 'toggle_on'}</span>
        </button>
      </div>`;

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
