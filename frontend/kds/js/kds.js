// KDS — modo oscuro estricto. Polling (sin libs externas) contra vista_kds_order_items.
const SUPABASE_URL = window.__ENV__?.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = window.__ENV__?.SUPABASE_ANON_KEY || '';
const PHP_API_BASE = window.__ENV__?.PHP_API_BASE || 'http://localhost:8000';
const POLL_INTERVAL_MS = 4000;
const READY_HIDE_AFTER_MS = 2 * 60 * 60 * 1000; // "Listo" desaparece de la vista tras 2h (no se borra el registro)

// ============================================================
// LOGIN — KDS vive en su propio subdominio, no comparte sesión con el POS.
// Login propio contra el mismo backend PHP, token guardado en localStorage local.
// ============================================================
function getToken() {
  return localStorage.getItem('kds_jwt') || '';
}

function showKds() {
  document.getElementById('screen-login').classList.add('hidden');
  document.getElementById('screen-kds').classList.remove('hidden');
  startPolling();
}

function showLogin() {
  document.getElementById('screen-kds').classList.add('hidden');
  document.getElementById('screen-login').classList.remove('hidden');
}

document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  errorEl.classList.add('hidden');
  try {
    const res = await fetch(`${PHP_API_BASE}/login.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Login fallido');
    const data = await res.json();
    if (data.user.role !== 'KITCHEN' && data.user.role !== 'ADMIN' && data.user.role !== 'SUPERADMIN') {
      throw new Error('Este usuario no tiene acceso a cocina');
    }
    localStorage.setItem('kds_jwt', data.token);
    showKds();
  } catch (err) {
    errorEl.textContent = err.message || 'Error al iniciar sesión';
    errorEl.classList.remove('hidden');
  }
});

// ============================================================
// ALERTA SONORA: nueva orden en "Pendientes"
// ============================================================
let audioCtx = null;
let seenPendingIds = null; // null = primera carga, no suena nada todavía
let audioUnlocked = false;

document.addEventListener('click', () => {
  if (audioUnlocked) return;
  audioUnlocked = true;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  document.getElementById('sound-hint')?.classList.add('hidden');
}, { once: true });

function playNewOrderBeep() {
  if (!audioCtx) return;
  [0, 0.18].forEach((delay) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.3, audioCtx.currentTime + delay);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + delay + 0.15);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(audioCtx.currentTime + delay);
    osc.stop(audioCtx.currentTime + delay + 0.16);
  });
}

async function fetchOrders() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/view_kds_order_items?select=*&kitchen_status=neq.DELIVERED&order=order_created_at.asc`,
    {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${getToken()}`,
      },
    }
  );
  if (res.status === 401) { localStorage.removeItem('kds_jwt'); showLogin(); throw new Error('Sesión expirada'); }
  if (!res.ok) throw new Error('Error consultando pedidos');
  return res.json();
}

async function updateKitchenStatus(orderId, status) {
  await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${getToken()}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ kitchen_status: status }),
  });
}

function groupByOrder(rows) {
  const orders = new Map();
  rows.forEach((row) => {
    if (!orders.has(row.order_id)) {
      orders.set(row.order_id, {
        order_id: row.order_id,
        daily_number: row.daily_number,
        kitchen_status: row.kitchen_status,
        created_at: row.order_created_at,
        ready_at: row.ready_at,
        items: [],
      });
    }
    orders.get(row.order_id).items.push(row);
  });
  return Array.from(orders.values())
    .filter((o) => !(o.kitchen_status === 'READY' && o.ready_at && (Date.now() - new Date(o.ready_at).getTime()) > READY_HIDE_AFTER_MS));
}

function elapsedMinutes(isoDate) {
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 60000);
}

function renderOrderCard(order, isNew) {
  const isReady = order.kitchen_status === 'READY' && order.ready_at;
  const mins = isReady
    ? Math.floor((new Date(order.ready_at).getTime() - new Date(order.created_at).getTime()) / 60000)
    : elapsedMinutes(order.created_at);
  const level = isReady ? 'ok' : mins >= 10 ? 'urgent' : mins >= 5 ? 'warning' : 'ok';
  const cardTone = {
    urgent: 'bg-zinc-900 border-error ring-4 ring-error/10',
    warning: 'bg-zinc-900 border-warning/40 ring-1 ring-warning/20',
    ok: 'bg-[#18181b] border-2 border-zinc-800 hover:border-zinc-700',
  }[level];
  const timeTone = {
    urgent: 'bg-error/20 text-error border-error/50',
    warning: 'bg-warning/10 text-warning border-warning/20',
    ok: 'bg-success/10 text-success border-success/20',
  }[level];
  const timeIcon = level === 'urgent' ? 'warning' : 'schedule';
  const card = document.createElement('article');
  card.dataset.orderId = order.order_id;
  card.className = `rounded-xl p-5 shadow-xl transition-all border-2 ${cardTone} ${isNew ? 'ring-4 ring-secondary animate-pulse' : ''}`;
  if (isNew) setTimeout(() => card.classList.remove('ring-4', 'ring-secondary', 'animate-pulse'), 4000);

  const itemsHtml = order.items.map((item) => {
    const removed = (item.removed_ingredients_named || [])
      .map((i) => `<p class="text-sm text-red-500 line-through">− ${i.name}</p>`)
      .join('');
    const extras = (item.added_extras_named || [])
      .map((i) => `<p class="text-sm text-primary font-medium">+ ${i.name} x${i.qty}</p>`)
      .join('');
    return `
      <label class="flex items-center gap-4 p-3 bg-zinc-800/30 rounded-lg cursor-pointer hover:bg-zinc-800/50 transition-colors">
        <input type="checkbox" class="w-8 h-8 rounded border-zinc-700 bg-zinc-900 text-primary focus:ring-primary shrink-0">
        <div class="flex-1">
          <span class="text-xl font-bold text-zinc-100">${item.quantity}× ${item.product_name}</span>
          ${removed}
          ${extras}
        </div>
      </label>`;
  }).join('');

  card.innerHTML = `
    <div class="flex justify-between items-start mb-4">
      <div>
        <h3 class="text-3xl font-headline font-black text-white">#${order.daily_number}</h3>
        <p class="text-zinc-500 font-bold text-sm">Pedido</p>
      </div>
      <div class="px-3 py-1 rounded-lg border flex items-center gap-2 ${timeTone}">
        <span class="material-symbols-outlined text-lg ${level === 'urgent' ? 'filled-icon' : ''}">${timeIcon}</span>
        <span class="text-xl font-bold font-label">${mins} min</span>
      </div>
    </div>
    <div class="space-y-3">
      ${itemsHtml}
    </div>
    ${nextActionButton(order, level)}`;

  card.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      cb.closest('label').classList.toggle('opacity-50', cb.checked);
    });
  });

  const btn = card.querySelector('.kds-action-btn');
  if (btn) {
    btn.addEventListener('click', async () => {
      await updateKitchenStatus(order.order_id, btn.dataset.next);
      await render();
      focusOrderCard(order.order_id);
    });
  }

  return card;
}

// ============================================================
// FOCO: al avanzar un pedido (Iniciar/Listo), saltar a su tarjeta en la
// nueva columna. Cada cocinero puede tener su propio pedido "agarrado"
// sin perderlo de vista aunque haya scrolleado a otra columna.
// ============================================================
function focusOrderCard(orderId) {
  const card = document.querySelector(`[data-order-id="${orderId}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  card.classList.add('ring-4', 'ring-secondary');
  setTimeout(() => card.classList.remove('ring-4', 'ring-secondary'), 2500);
}

function nextActionButton(order, level) {
  if (order.kitchen_status === 'PENDING') {
    const urgentClass = level === 'urgent' ? 'bg-error shadow-error/20' : 'bg-primary shadow-primary/20';
    return `<button class="kds-action-btn mt-6 w-full py-4 ${urgentClass} text-white font-black uppercase tracking-widest rounded-lg hover:brightness-110 active:scale-95 transition-all flex items-center justify-center gap-2 shadow-lg" data-next="IN_PROGRESS">
      <span class="material-symbols-outlined">play_arrow</span>Iniciar
    </button>`;
  }
  if (order.kitchen_status === 'IN_PROGRESS') {
    return `<button class="kds-action-btn mt-6 w-full py-4 bg-zinc-800 text-zinc-300 font-bold uppercase tracking-widest rounded-lg border border-zinc-700 hover:bg-zinc-700 transition-all flex items-center justify-center gap-2" data-next="READY">
      <span class="material-symbols-outlined">check_circle</span>Marcar listo
    </button>`;
  }
  return `<button class="kds-action-btn mt-6 w-full py-4 bg-zinc-800 text-zinc-300 font-bold uppercase tracking-widest rounded-lg border border-zinc-700 hover:bg-zinc-700 transition-all flex items-center justify-center gap-2" data-next="DELIVERED">
    <span class="material-symbols-outlined">done_all</span>Entregado
  </button>`;
}

async function render() {
  try {
    const rows = await fetchOrders();
    const orders = groupByOrder(rows);
    const cols = {
      PENDING: document.getElementById('col-pending'),
      IN_PROGRESS: document.getElementById('col-progress'),
      READY: document.getElementById('col-ready'),
    };

    const currentPendingIds = new Set(orders.filter((o) => o.kitchen_status === 'PENDING').map((o) => o.order_id));
    const newPendingIds = seenPendingIds
      ? new Set([...currentPendingIds].filter((id) => !seenPendingIds.has(id)))
      : new Set(); // primera carga: no alertar de órdenes que ya estaban ahí
    if (newPendingIds.size > 0) playNewOrderBeep();
    seenPendingIds = currentPendingIds;

    Object.values(cols).forEach((c) => (c.innerHTML = ''));
    orders.forEach((order) => {
      const col = cols[order.kitchen_status];
      if (col) col.appendChild(renderOrderCard(order, newPendingIds.has(order.order_id)));
    });
    document.getElementById('count-pending').textContent = orders.filter((o) => o.kitchen_status === 'PENDING').length;
    document.getElementById('count-progress').textContent = orders.filter((o) => o.kitchen_status === 'IN_PROGRESS').length;
    document.getElementById('count-ready').textContent = orders.filter((o) => o.kitchen_status === 'READY').length;
    // "En cocina" = solo lo que sigue en proceso real (Pendiente + En preparación).
    // Lo Listo ya no cuenta aquí, aunque siga visible en su columna hasta que se entregue.
    document.getElementById('active-count').textContent = orders.filter((o) => o.kitchen_status !== 'READY').length;
  } catch (e) {
    console.error(e);
  }
}

function tickClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  document.getElementById('clock').textContent = `${hh}:${mm}`;
}

async function updateAvgPrepTime() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?ready_at=not.is.null&order=created_at.desc&limit=20&select=created_at,ready_at`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${getToken()}` } }
    );
    if (!res.ok) throw new Error('Error consultando promedio');
    const rows = await res.json();
    if (!rows.length) {
      document.getElementById('avg-prep-time').textContent = '--';
      return;
    }
    const avgMs = rows.reduce((sum, o) => sum + (new Date(o.ready_at) - new Date(o.created_at)), 0) / rows.length;
    document.getElementById('avg-prep-time').textContent = Math.round(avgMs / 60000);
  } catch (e) {
    console.error(e);
  }
}

document.getElementById('btn-refresh').addEventListener('click', () => { render(); updateAvgPrepTime(); });
document.getElementById('btn-kds-logout').addEventListener('click', () => {
  localStorage.removeItem('kds_jwt');
  location.reload();
});

let pollingStarted = false;
function startPolling() {
  if (pollingStarted) return;
  pollingStarted = true;
  render();
  updateAvgPrepTime();
  setInterval(updateAvgPrepTime, POLL_INTERVAL_MS * 5);
  setInterval(render, POLL_INTERVAL_MS);
}

tickClock();
setInterval(tickClock, 1000);

if (getToken()) {
  showKds();
} else {
  showLogin();
}
