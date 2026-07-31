// Panel ADMIN — Gestión de usuarios/cajeros (crear, cambiar rol, activar/desactivar, resetear contraseña)
import { getSessionValue } from './db.js';
import { phpPost, supabaseGet } from './api.js';

const PHP_API_BASE = window.__ENV__?.PHP_API_BASE || 'http://localhost:8000/api';

function el(id) { return document.getElementById(id); }

let currentUserId = null;
let locations = [];

async function phpGet(endpoint) {
  const token = await getSessionValue('jwt');
  const res = await fetch(`${PHP_API_BASE}/${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error((await res.json()).error || 'Error de red');
  return res.json();
}

export async function loadUsersView() {
  const user = await getSessionValue('user');
  if (!user) return;
  currentUserId = user.id;

  locations = await supabaseGet(`locations?tenant_id=eq.${user.tenant_id}&select=id,name`);
  populateLocationSelect();

  const users = await phpGet('users_manage.php?action=list');
  renderUsersList(users);
}

function populateLocationSelect() {
  el('user-location').innerHTML =
    '<option value="">Dueño / ve todas las sucursales (no puede abrir caja)</option>' +
    locations.map((l) => `<option value="${l.id}">${l.name}</option>`).join('');
}

function locationName(id) {
  return locations.find((l) => l.id === id)?.name || 'Sin sucursal';
}

function renderUsersList(users) {
  const wrap = el('users-list');
  wrap.innerHTML = '';

  if (!users.length) {
    wrap.innerHTML = `<div class="text-center text-slate-400 py-10">No hay usuarios todavía.</div>`;
    return;
  }

  const roleLabel = { ADMIN: 'Administrador', CASHIER: 'Cajero', KITCHEN: 'Cocina', SUPERADMIN: 'Superadmin' };

  users.forEach((u) => {
    const isSelf = u.id === currentUserId;
    const row = document.createElement('div');
    row.className = 'bg-slate-50 rounded-xl p-4 flex items-center gap-4';
    row.innerHTML = `
      <div class="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-sm shrink-0">
        ${u.username.slice(0, 2).toUpperCase()}
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <h4 class="font-bold text-slate-800 truncate">${u.username}</h4>
          ${u.status === 'DISABLED' ? `<span class="text-[10px] font-bold uppercase bg-slate-200 text-slate-500 px-2 py-0.5 rounded-full">Desactivado</span>` : ''}
          ${isSelf ? `<span class="text-[10px] font-bold uppercase bg-primary/10 text-primary px-2 py-0.5 rounded-full">Tú</span>` : ''}
        </div>
        <p class="text-xs text-slate-400">${locationName(u.location_id)}</p>
      </div>
      <select class="user-role-select h-10 px-2 rounded-lg border border-slate-300 text-sm" ${u.role === 'SUPERADMIN' || isSelf ? 'disabled' : ''}>
        <option value="CASHIER" ${u.role === 'CASHIER' ? 'selected' : ''}>Cajero</option>
        <option value="KITCHEN" ${u.role === 'KITCHEN' ? 'selected' : ''}>Cocina</option>
        <option value="ADMIN" ${u.role === 'ADMIN' ? 'selected' : ''}>Administrador</option>
        ${u.role === 'SUPERADMIN' ? `<option value="SUPERADMIN" selected>Superadmin</option>` : ''}
      </select>
      <div class="flex items-center gap-1 shrink-0">
        ${isSelf && (u.role === 'ADMIN' || u.role === 'SUPERADMIN') ? `
        <button class="btn-set-pin p-2 rounded-lg text-slate-400 hover:bg-slate-200 hover:text-primary transition-colors" title="Configurar PIN de confirmación">
          <span class="material-symbols-outlined text-lg">password</span>
        </button>` : ''}
        <button class="btn-reset-password p-2 rounded-lg text-slate-400 hover:bg-slate-200 hover:text-primary transition-colors" title="Restablecer contraseña">
          <span class="material-symbols-outlined text-lg">lock_reset</span>
        </button>
        <button class="btn-toggle-status p-2 rounded-lg text-slate-400 hover:bg-slate-200 transition-colors ${u.status === 'DISABLED' ? 'hover:text-success' : 'hover:text-red-500'}"
          title="${u.status === 'DISABLED' ? 'Activar' : 'Desactivar'}" ${isSelf ? 'disabled' : ''}>
          <span class="material-symbols-outlined text-lg">${u.status === 'DISABLED' ? 'toggle_off' : 'toggle_on'}</span>
        </button>
      </div>`;

    const roleSelect = row.querySelector('.user-role-select');
    roleSelect.addEventListener('change', async () => {
      try {
        await phpPost('users_manage.php?action=update_role', { user_id: u.id, role: roleSelect.value });
        await loadUsersView();
      } catch (err) {
        alert(err.message || 'Error al cambiar el rol');
        roleSelect.value = u.role;
      }
    });

    row.querySelector('.btn-set-pin')?.addEventListener('click', async () => {
      const pin = prompt('Nuevo PIN de confirmación (4 a 6 dígitos). Se pedirá para modificar órdenes ya cobradas.');
      if (pin === null) return;
      if (!/^\d{4,6}$/.test(pin)) return alert('El PIN debe ser numérico, de 4 a 6 dígitos');
      try {
        await phpPost('users_manage.php?action=set_pin', { pin });
        alert('PIN configurado');
      } catch (err) {
        alert(err.message || 'Error al configurar el PIN');
      }
    });

    row.querySelector('.btn-reset-password').addEventListener('click', () => openResetPasswordModal(u));
    row.querySelector('.btn-toggle-status').addEventListener('click', async () => {
      const newStatus = u.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED';
      if (!confirm(`¿${newStatus === 'ACTIVE' ? 'Activar' : 'Desactivar'} a "${u.username}"?`)) return;
      try {
        await phpPost('users_manage.php?action=toggle_status', { user_id: u.id, status: newStatus });
        await loadUsersView();
      } catch (err) {
        alert(err.message || 'Error al cambiar el estado');
      }
    });

    wrap.appendChild(row);
  });
}

// ============================================================
// CREAR USUARIO
// ============================================================
el('btn-new-user')?.addEventListener('click', () => {
  el('form-user').reset();
  el('user-form-error').classList.add('hidden');
  el('modal-user').classList.remove('hidden');
  el('modal-user').classList.add('flex');
});

el('btn-user-cancel')?.addEventListener('click', () => {
  el('modal-user').classList.add('hidden');
  el('modal-user').classList.remove('flex');
});

el('form-user')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  el('user-form-error').classList.add('hidden');
  try {
    await phpPost('users_create.php', {
      username: el('user-username').value.trim(),
      password: el('user-password').value,
      role: el('user-role').value,
      location_id: el('user-location').value || null,
    });
    el('modal-user').classList.add('hidden');
    el('modal-user').classList.remove('flex');
    await loadUsersView();
  } catch (err) {
    el('user-form-error').textContent = err.message || 'Error al crear usuario';
    el('user-form-error').classList.remove('hidden');
  }
});

// ============================================================
// RESETEAR CONTRASEÑA
// ============================================================
let resetPasswordUser = null;

function openResetPasswordModal(user) {
  resetPasswordUser = user;
  el('reset-password-username').textContent = user.username;
  el('form-reset-password').reset();
  el('modal-reset-password').classList.remove('hidden');
  el('modal-reset-password').classList.add('flex');
}

el('btn-reset-password-cancel')?.addEventListener('click', () => {
  el('modal-reset-password').classList.add('hidden');
  el('modal-reset-password').classList.remove('flex');
});

el('form-reset-password')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await phpPost('users_manage.php?action=reset_password', {
      user_id: resetPasswordUser.id,
      new_password: el('reset-password-new').value,
    });
    el('modal-reset-password').classList.add('hidden');
    el('modal-reset-password').classList.remove('flex');
    alert(`Contraseña de "${resetPasswordUser.username}" actualizada.`);
  } catch (err) {
    alert(err.message || 'Error al restablecer la contraseña');
  }
});
