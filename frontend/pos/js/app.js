import { openDb, putAll, getAll, setSessionValue, getSessionValue, enqueueSync, drainSyncQueue } from './db.js';
import { login, phpPost, supabaseGet, supabasePost, isOnline } from './api.js';
import { openModifiers } from './modifiers.js';
import { loadSettingsView } from './settings.js';
import { loadUsersView } from './users.js';
import { loadInventoryView } from './inventory.js';
import { loadChecklistSettings, runChecklist } from './checklist.js';
import { enterSuperAdmin } from './superadmin.js';

let session = null; // { token, user }
let cashSessionId = null;
let cashOpeningBalance = 0;
let cashAlertThreshold = null;
let autoPrintReceipt = true;
let kdsEnabled = true;
let showProductImages = true;
let products = [];
let recipes = [];
let supplies = [];
let lowStockSupplyIds = new Set();
let ticket = []; // [{product, quantity, unit_price, modifiers, extrasTotal}]
let discountAmount = 0;

const el = (id) => document.getElementById(id);
const toast = (msg) => {
  const t = el('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2500);
};
const money = (n) => `$${Number(n).toFixed(2)}`;

// ============================================================
// BOOTSTRAP
// ============================================================
(async function init() {
  await openDb();
  const token = await getSessionValue('jwt');
  const user = await getSessionValue('user');
  cashSessionId = await getSessionValue('cash_session_id');

  if (token && user) {
    session = { token, user };
    await enterApp();
  } else {
    showScreen('login');
  }

  window.addEventListener('online', syncPendingSales);
})();

function showScreen(name) {
  el('screen-login').classList.toggle('hidden', name !== 'login');
  el('app').classList.toggle('hidden', name !== 'app');
}

// ============================================================
// LOGIN
// ============================================================
el('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = el('login-username').value.trim();
  const password = el('login-password').value;
  el('login-error').classList.add('hidden');
  try {
    const result = await login(username, password);
    await setSessionValue('jwt', result.token);
    await setSessionValue('user', result.user);
    session = { token: result.token, user: result.user };
    await enterApp();
  } catch (err) {
    el('login-error').textContent = err.message;
    el('login-error').classList.remove('hidden');
  }
});

el('btn-logout').addEventListener('click', async () => {
  await setSessionValue('jwt', null);
  await setSessionValue('user', null);
  await setSessionValue('cash_session_id', null);
  session = null;
  cashSessionId = null;
  location.reload();
});

function applyKdsVisibility() {
  const kdsBtn = document.querySelector('.nav-btn[data-view="kds"]');
  if (kdsBtn) kdsBtn.classList.toggle('hidden', !kdsEnabled);
}

async function enterApp() {
  if (session.user.role === 'KITCHEN') {
    location.href = window.__ENV__?.KDS_URL || '/kds/';
    return;
  }
  if (session.user.role === 'SUPERADMIN') {
    await enterSuperAdmin(session);
    return;
  }
  el('user-label').textContent = `${session.user.username} (${session.user.role})`;
  el('user-avatar').textContent = session.user.username.slice(0, 2).toUpperCase();
  applyRoleUi();
  showScreen('app');
  await loadCatalog();
  renderTicket();

  // El puntero local (IndexedDB) se pierde al cerrar sesión o cambiar de dispositivo,
  // pero la caja real puede seguir abierta en la base. Si no hay puntero local,
  // se busca en Supabase antes de pedir abrir una nueva (evita cajas huérfanas).
  if (!cashSessionId && isOnline() && session.user.location_id) {
    try {
      const openSessions = await supabaseGet(
        `cash_sessions?location_id=eq.${session.user.location_id}&status=eq.OPEN&order=opened_at.desc&limit=1`
      );
      if (openSessions[0]) {
        cashSessionId = openSessions[0].id;
        await setSessionValue('cash_session_id', cashSessionId);
      }
    } catch {
      // sin conexión a Supabase: sigue el flujo normal y pide abrir turno
    }
  }

  // El fondo inicial (cashOpeningBalance) solo vive en memoria, no en IndexedDB.
  // Al reabrir la app con un cash_session_id ya cacheado (sin haber pasado por
  // "Salir") esta variable se perdía y quedaba en 0 — siempre hay que refrescarla
  // desde la base mientras haya una caja abierta y conexión.
  if (cashSessionId && isOnline()) {
    try {
      const rows = await supabaseGet(`cash_sessions?id=eq.${cashSessionId}&select=opening_balance`);
      if (rows[0]) cashOpeningBalance = Number(rows[0].opening_balance) || 0;
    } catch {
      // sin conexión: se mantiene el valor previo en memoria
    }
  }

  if (isOnline()) {
    try {
      const locationId = session.user.location_id
        || (await supabaseGet(`locations?tenant_id=eq.${session.user.tenant_id}&select=id&limit=1`))[0]?.id;
      if (locationId) {
        const loc = (await supabaseGet(`locations?id=eq.${locationId}&select=settings`))[0];
        cashAlertThreshold = loc?.settings?.cash_alert_threshold ?? null;
        autoPrintReceipt = loc?.settings?.auto_print_receipt ?? true;
        kdsEnabled = loc?.settings?.kds_enabled ?? true;
        showProductImages = loc?.settings?.show_product_images ?? true;
        applyKdsVisibility();
        applyProductFilters();
      }
    } catch {
      cashAlertThreshold = null;
    }
  }

  if (cashSessionId) await checkCashAlert();

  // Abrir turno ya no bloquea la pantalla: solo impide cobrar hasta que se abra.
  // Se puede seguir consultando Productos/Inventario/Configuración sin turno.
  updateNoSessionBanner();
  syncPendingSales();
}

function updateNoSessionBanner() {
  const banner = el('no-session-banner');
  banner.classList.toggle('hidden', !!cashSessionId);
  banner.classList.toggle('flex', !cashSessionId);
}

function applyRoleUi() {
  const isAdmin = session.user.role === 'ADMIN' || session.user.role === 'SUPERADMIN';
  document.querySelectorAll('.admin-only').forEach((n) => {
    n.classList.toggle('hidden', !isAdmin);
  });
  if (isAdmin) {
    el('side-nav').classList.remove('hidden');
    el('side-nav').classList.add('flex');
  }
}

// ============================================================
// DRAWER de navegación (mobile) — el sidebar se abre/cierra con ☰
// ============================================================
function openNavDrawer() {
  el('side-nav').classList.remove('-translate-x-full');
  el('side-nav').classList.add('translate-x-0');
  el('nav-backdrop').classList.remove('hidden');
  el('nav-backdrop').classList.add('block');
}
function closeNavDrawer() {
  el('side-nav').classList.add('-translate-x-full');
  el('side-nav').classList.remove('translate-x-0');
  el('nav-backdrop').classList.add('hidden');
  el('nav-backdrop').classList.remove('block');
}
el('btn-nav-toggle')?.addEventListener('click', openNavDrawer);
el('nav-backdrop')?.addEventListener('click', closeNavDrawer);

// ============================================================
// NAV — cambio de vista (Caja / KDS / Inventario / Configuración)
// ============================================================
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    closeNavDrawer();
    document.querySelectorAll('.nav-btn').forEach((b) => {
      b.classList.remove('bg-primary/10', 'text-primary', 'border-r-4', 'border-primary');
      b.classList.add('text-gray-400');
    });
    btn.classList.remove('text-gray-400');
    btn.classList.add('bg-primary/10', 'text-primary', 'border-r-4', 'border-primary');

    const view = btn.dataset.view;
    if (view === 'kds') {
      window.open(window.__ENV__?.KDS_URL || '/kds/', '_blank');
      return;
    }

    el('view-caja').classList.toggle('hidden', view !== 'caja');
    el('view-caja').classList.toggle('flex', view === 'caja');
    el('view-inventory').classList.toggle('hidden', view !== 'inventory');
    el('view-inventory').classList.toggle('flex', view === 'inventory');
    el('view-settings').classList.toggle('hidden', view !== 'settings');
    el('view-settings').classList.toggle('flex', view === 'settings');

    if (view === 'settings') { await loadSettingsView(); await loadUsersView(); await loadChecklistSettings(); }
    if (view === 'inventory') await loadInventoryView();
    if (view === 'caja') await loadCatalog();
  });
});

// ============================================================
// CATALOG (offline-first: intenta red, cae a IndexedDB)
// ============================================================
async function loadCatalog() {
  try {
    if (isOnline()) {
      products = await supabaseGet('products?select=*&active=eq.true');
      recipes = await supabaseGet('recipes_bom?select=*');
      supplies = await supabaseGet('inventory_catalog?select=*');
      await putAll('products', products);
      await putAll('recipes_bom', recipes);
      await putAll('inventory_catalog', supplies);
    } else {
      throw new Error('offline');
    }
  } catch {
    products = await getAll('products');
    recipes = await getAll('recipes_bom');
    supplies = await getAll('inventory_catalog');
  }
  await sortProductsByBestSellers();
  await loadLowStockWarnings();
  renderCategories();
  renderProductGrid(products);
}

// ============================================================
// ORDENAR CATÁLOGO POR MÁS VENDIDOS (últimos 30 días)
// ============================================================
async function sortProductsByBestSellers() {
  if (!isOnline() || !session.user.location_id) return;
  try {
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const orders = await supabaseGet(
      `orders?location_id=eq.${session.user.location_id}&status=eq.PAID&created_at=gte.${since.toISOString()}&select=id`
    );
    if (!orders.length) return;

    const orderIds = orders.map((o) => o.id);
    const items = await supabaseGet(`order_items?order_id=in.(${orderIds.join(',')})&select=product_id,quantity`);
    const qtyByProduct = {};
    items.forEach((i) => { qtyByProduct[i.product_id] = (qtyByProduct[i.product_id] || 0) + Number(i.quantity); });

    products.sort((a, b) => (qtyByProduct[b.id] || 0) - (qtyByProduct[a.id] || 0));
  } catch {
    // sin conexión o error: se queda con el orden original, no bloquea el catálogo
  }
}

async function loadLowStockWarnings() {
  lowStockSupplyIds = new Set();
  if (!isOnline() || !session.user.location_id) return;
  try {
    const stock = await supabaseGet(`inventory_stock?location_id=eq.${session.user.location_id}&select=catalog_id,current_stock,safety_stock`);
    stock.forEach((s) => {
      if (Number(s.current_stock) <= Number(s.safety_stock)) lowStockSupplyIds.add(s.catalog_id);
    });
  } catch {
    // sin conexión a Supabase: no se puede verificar, se omite el aviso
  }
}

function productHasLowStock(productId) {
  return recipes.some((r) => r.product_id === productId && lowStockSupplyIds.has(r.ingredient_id));
}

function renderCategories() {
  const cats = ['Todos', ...new Set(products.map((p) => p.category).filter(Boolean))];
  const wrap = el('category-tabs');
  wrap.innerHTML = '';
  const activeChipClass = 'shrink-0 px-6 py-2.5 rounded-full bg-primary text-white font-bold text-sm shadow-lg shadow-primary/20 whitespace-nowrap';
  const inactiveChipClass = 'shrink-0 px-6 py-2.5 rounded-full bg-white text-slate-600 hover:bg-slate-50 font-semibold text-sm border border-slate-200 whitespace-nowrap transition-all';
  cats.forEach((cat, i) => {
    const btn = document.createElement('button');
    btn.className = i === 0 ? activeChipClass : inactiveChipClass;
    btn.textContent = cat;
    btn.addEventListener('click', () => {
      wrap.querySelectorAll('button').forEach((b) => b.className = inactiveChipClass);
      btn.className = activeChipClass;
      applyProductFilters();
    });
    wrap.appendChild(btn);
  });
}

function renderProductGrid(list) {
  const grid = el('product-grid');
  grid.innerHTML = '';
  if (!list.length) {
    grid.innerHTML = `<div class="col-span-full text-center text-slate-400 py-10">Sin resultados</div>`;
    return;
  }
  list.forEach((p) => {
    const lowStock = productHasLowStock(p.id);
    const card = document.createElement('div');
    card.className = `bg-white rounded-xl p-3 border shadow-sm hover:shadow-md transition-all cursor-pointer group active:scale-[0.98] relative ${
      lowStock ? 'border-amber-400 ring-1 ring-amber-300' : 'border-slate-200 hover:border-primary/30'
    }`;
    card.innerHTML = `
      ${lowStock ? `<span title="Insumo con stock bajo" class="absolute top-1.5 right-1.5 z-10 w-6 h-6 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center"><span class="material-symbols-outlined text-sm">warning</span></span>` : ''}
      ${showProductImages ? `
      <div class="aspect-square rounded-lg overflow-hidden bg-slate-100 mb-3">
        ${p.image_url ? `<img src="${p.image_url}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300">` : ''}
      </div>
      <h3 class="font-headline font-bold text-slate-800 text-sm leading-tight mb-1">${p.name}</h3>` : `
      <h3 class="font-headline font-bold text-slate-800 text-lg leading-tight mb-3">${p.name}</h3>`}
      <div class="flex justify-between items-center">
        <span class="text-primary font-black ${showProductImages ? '' : 'text-xl'}">${money(p.base_price)}</span>
        <div class="btn-add w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 group-hover:bg-secondary group-hover:text-white transition-colors">
          <span class="material-symbols-outlined text-sm">add</span>
        </div>
      </div>`;
    card.addEventListener('click', () => addProductToTicket(p));
    grid.appendChild(card);
  });
}

function currentCategoryFilter() {
  const activeChip = el('category-tabs').querySelector('button.bg-primary');
  return activeChip && activeChip.textContent !== 'Todos' ? activeChip.textContent : null;
}

function applyProductFilters() {
  const query = el('product-search').value.trim().toLowerCase();
  const cat = currentCategoryFilter();
  let list = cat ? products.filter((p) => p.category === cat) : products;
  if (query) list = list.filter((p) => p.name.toLowerCase().includes(query));
  renderProductGrid(list);
}

el('product-search').addEventListener('input', applyProductFilters);

// ============================================================
// TICKET
// ============================================================
async function addProductToTicket(product) {
  const supplyById = Object.fromEntries(supplies.map((s) => [s.id, s]));
  const baseIngredients = recipes
    .filter((r) => r.product_id === product.id)
    .map((r) => ({ id: r.ingredient_id, name: supplyById[r.ingredient_id]?.name || 'Insumo eliminado' }));

  // Extras disponibles: solo insumos del tenant que NO forman parte de la receta base,
  // y solo si el producto tiene escandallo propio (si no, no hay contexto para ofrecer extras).
  const baseIds = new Set(baseIngredients.map((i) => i.id));
  const availableExtras = baseIngredients.length
    ? supplies
        .filter((s) => !baseIds.has(s.id))
        .map((s) => ({ id: s.id, name: s.name, extra_price: Number(s.unit_cost) || 0 }))
    : [];

  let modifiers = { removed_ingredients: [], added_extras: [] };
  if (baseIngredients.length || availableExtras.length) {
    const result = await openModifiers(product, baseIngredients, availableExtras);
    if (result === null) return; // cancelado
    modifiers = result;
  }

  const extrasTotal = modifiers.added_extras.reduce((s, e) => s + e.extra_price * e.qty, 0);
  ticket.push({
    product,
    quantity: 1,
    unit_price: product.base_price + extrasTotal,
    modifiers,
  });
  renderTicket();
}

function renderTicket() {
  const wrap = el('ticket-items');
  wrap.innerHTML = '';

  if (!ticket.length) {
    wrap.innerHTML = `
      <div class="h-full flex flex-col items-center justify-center text-center text-slate-400 gap-2 py-10">
        <svg class="w-12 h-12 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m-10 0a2 2 0 100 4 2 2 0 000-4zm10 0a2 2 0 100 4 2 2 0 000-4z"/></svg>
        <p class="text-sm font-medium">Aún no hay productos</p>
        <p class="text-xs">Toca un producto para agregarlo</p>
      </div>`;
    updateTicketTotals();
    return;
  }

  ticket.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'p-4 rounded-xl bg-gray-50 border border-gray-100 flex flex-col gap-3 group';
    const modNotes = [
      ...item.modifiers.removed_ingredients.map(() => `Sin ingrediente`),
      ...item.modifiers.added_extras.map((e) => `+${e.qty} extra`),
    ].join(', ');
    row.innerHTML = `
      <div class="flex justify-between items-start">
        <div class="min-w-0">
          <h4 class="font-bold text-slate-800 text-sm truncate">${item.product.name}</h4>
          ${modNotes ? `<p class="text-xs text-slate-400">${modNotes}</p>` : ''}
        </div>
        <span class="font-black text-slate-900 shrink-0">${money(item.unit_price * item.quantity)}</span>
      </div>
      <div class="flex justify-between items-center">
        <div class="flex items-center gap-3">
          <button class="qty-minus w-8 h-8 rounded-lg bg-white border border-gray-200 flex items-center justify-center text-slate-400 hover:text-primary hover:border-primary transition-colors active:scale-90">
            <span class="material-symbols-outlined text-base">remove</span>
          </button>
          <span class="font-bold text-slate-700 w-4 text-center">${item.quantity}</span>
          <button class="qty-plus w-8 h-8 rounded-lg bg-white border border-gray-200 flex items-center justify-center text-slate-400 hover:text-primary hover:border-primary transition-colors active:scale-90">
            <span class="material-symbols-outlined text-base">add</span>
          </button>
        </div>
        <button class="remove-item p-2 text-gray-300 hover:text-red-500 transition-colors">
          <span class="material-symbols-outlined text-lg">delete</span>
        </button>
      </div>`;
    row.querySelector('.qty-minus').addEventListener('click', () => {
      item.quantity -= 1;
      if (item.quantity <= 0) ticket.splice(idx, 1);
      renderTicket();
    });
    row.querySelector('.qty-plus').addEventListener('click', () => {
      item.quantity += 1;
      renderTicket();
    });
    row.querySelector('.remove-item').addEventListener('click', () => {
      ticket.splice(idx, 1);
      renderTicket();
    });
    wrap.appendChild(row);
  });

  updateTicketTotals();
}

function ticketSubtotal() {
  return ticket.reduce((s, i) => s + i.unit_price * i.quantity, 0);
}

function ticketTotal() {
  return Math.max(0, ticketSubtotal() - discountAmount);
}

function updateTicketTotals() {
  const subtotal = ticketSubtotal();
  el('ticket-subtotal').textContent = money(subtotal);

  const cappedDiscount = Math.min(discountAmount, subtotal);
  el('ticket-discount-row').classList.toggle('hidden', cappedDiscount <= 0);
  el('ticket-discount-row').classList.toggle('flex', cappedDiscount > 0);
  el('ticket-discount').textContent = `-${money(cappedDiscount)}`;

  el('ticket-total').textContent = money(ticketTotal());
  el('btn-charge').disabled = ticket.length === 0 || !cashSessionId;

  const totalQty = ticket.reduce((sum, i) => sum + i.quantity, 0);
  const badge = el('caja-mobile-ticket-badge');
  badge.textContent = totalQty;
  badge.classList.toggle('hidden', totalQty === 0);
  badge.classList.toggle('flex', totalQty > 0);
}

// ============================================================
// MOBILE: toggle entre Productos y Ticket (en sm+ se ven ambos siempre)
// ============================================================
function showMobileCajaTab(tab) {
  el('view-pos').classList.toggle('hidden', tab !== 'products');
  el('ticket-panel').classList.toggle('hidden', tab !== 'ticket');
  el('ticket-panel').classList.toggle('flex', tab === 'ticket');
  el('caja-mobile-tab-products').classList.toggle('text-primary', tab === 'products');
  el('caja-mobile-tab-products').classList.toggle('border-b-2', tab === 'products');
  el('caja-mobile-tab-products').classList.toggle('border-primary', tab === 'products');
  el('caja-mobile-tab-products').classList.toggle('text-slate-400', tab !== 'products');
  el('caja-mobile-tab-ticket').classList.toggle('text-primary', tab === 'ticket');
  el('caja-mobile-tab-ticket').classList.toggle('border-b-2', tab === 'ticket');
  el('caja-mobile-tab-ticket').classList.toggle('border-primary', tab === 'ticket');
  el('caja-mobile-tab-ticket').classList.toggle('text-slate-400', tab !== 'ticket');
}

el('caja-mobile-tab-products').addEventListener('click', () => showMobileCajaTab('products'));
el('caja-mobile-tab-ticket').addEventListener('click', () => showMobileCajaTab('ticket'));

el('btn-clear-ticket').addEventListener('click', () => {
  ticket = [];
  discountAmount = 0;
  renderTicket();
});

el('btn-remove-discount').addEventListener('click', () => {
  discountAmount = 0;
  updateTicketTotals();
});

el('btn-discount').addEventListener('click', () => {
  const subtotal = ticketSubtotal();
  if (subtotal <= 0) return toast('Agrega productos primero');

  const choice = prompt('Tipo de descuento: escribe "%" para porcentaje o "$" para monto fijo', '%');
  if (choice === null) return;

  const isPercent = choice.trim().startsWith('%');
  const valueStr = prompt(isPercent ? '¿Qué porcentaje de descuento?' : '¿Cuánto descuento en pesos?');
  if (valueStr === null) return;
  const value = parseFloat(valueStr);
  if (isNaN(value) || value < 0) return toast('Valor inválido');

  discountAmount = isPercent ? subtotal * (Math.min(value, 100) / 100) : value;
  updateTicketTotals();
  toast('Descuento aplicado');
});

el('btn-split-bill').addEventListener('click', () => {
  const total = ticketTotal();
  if (total <= 0) return toast('Agrega productos primero');

  const peopleStr = prompt('¿Entre cuántas personas se divide la cuenta?', '2');
  if (peopleStr === null) return;
  const people = parseInt(peopleStr, 10);
  if (isNaN(people) || people < 2) return toast('Ingresa un número válido (2 o más)');

  const perPerson = total / people;
  alert(`Total: ${money(total)}\nEntre ${people} personas: ${money(perPerson)} cada uno.\n\nEsto es solo informativo — la venta se sigue cobrando como un solo pago.`);
});

// ============================================================
// CASH SESSION — apertura / corte Z
// ============================================================
el('btn-open-session').addEventListener('click', async () => {
  const opening = parseFloat(el('opening-balance').value);
  if (isNaN(opening) || opening < 0) return toast('Fondo inicial inválido');
  await runChecklist('OPENING');
  try {
    const result = await phpPost('cash_session.php?action=open', { opening_balance: opening });
    cashSessionId = result.id;
    cashOpeningBalance = opening;
    await setSessionValue('cash_session_id', cashSessionId);
    el('screen-open-session').classList.add('hidden');
    el('screen-open-session').classList.remove('flex');
    renderTicket();
    updateNoSessionBanner();
    await checkCashAlert();
  } catch (err) {
    toast(err.message);
  }
});

el('btn-open-session-inline')?.addEventListener('click', () => {
  el('screen-open-session').classList.remove('hidden');
  el('screen-open-session').classList.add('flex');
});

el('btn-cancel-open-session')?.addEventListener('click', () => {
  el('screen-open-session').classList.add('hidden');
  el('screen-open-session').classList.remove('flex');
});

el('btn-close-session').addEventListener('click', async () => {
  if (!cashSessionId) return toast('No hay turno abierto');
  await runChecklist('CLOSING', cashSessionId);
  const actual = prompt('Efectivo contado en caja ($):');
  if (actual === null) return;
  try {
    const result = await phpPost('cash_session.php?action=close', {
      session_id: cashSessionId,
      actual_balance: parseFloat(actual),
    });
    alert(
      `Corte Z\nEsperado: ${money(result.expected_balance)}\nContado: ${money(result.actual_balance)}\nDiferencia: ${money(result.discrepancy)}`
    );
    cashSessionId = null;
    await setSessionValue('cash_session_id', null);
    location.reload();
  } catch (err) {
    toast(err.message);
  }
});

// ============================================================
// CHECKOUT — modal de pago -> WhatsApp/DB, soporta offline sync queue
// ============================================================
let selectedPaymentMethod = null;

el('btn-charge').addEventListener('click', () => {
  const total = ticketTotal();
  el('payment-total').textContent = money(total);
  selectedPaymentMethod = null;
  el('cash-tendered').value = '';
  el('cash-change').textContent = money(0);
  el('cash-tendered-wrap').classList.add('hidden');
  document.querySelectorAll('.payment-method-btn').forEach((b) => b.classList.remove('bg-primary', 'text-white'));
  el('btn-confirm-payment').disabled = true;
  el('modal-payment').classList.remove('hidden');
  el('modal-payment').classList.add('flex');
});

function updateCashChange() {
  const total = ticketTotal();
  const tendered = Number(el('cash-tendered').value) || 0;
  const change = Math.max(tendered - total, 0);
  el('cash-change').textContent = money(change);
  el('btn-confirm-payment').disabled = tendered < total;
}

el('cash-tendered').addEventListener('input', updateCashChange);

document.querySelectorAll('.payment-method-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    selectedPaymentMethod = btn.dataset.method;
    document.querySelectorAll('.payment-method-btn').forEach((b) => b.classList.remove('bg-primary', 'text-white'));
    btn.classList.add('bg-primary', 'text-white');
    if (selectedPaymentMethod === 'CASH') {
      el('cash-tendered-wrap').classList.remove('hidden');
      updateCashChange();
    } else {
      el('cash-tendered-wrap').classList.add('hidden');
      el('btn-confirm-payment').disabled = false;
    }
  });
});

el('btn-confirm-payment').addEventListener('click', async () => {
  const total = ticketTotal();
  const cashTendered = selectedPaymentMethod === 'CASH' ? Number(el('cash-tendered').value) || 0 : null;
  const cashChange = cashTendered !== null ? Math.max(cashTendered - total, 0) : null;
  const orderPayload = {
    location_id: session.user.location_id,
    tenant_id: session.user.tenant_id,
    cash_session_id: cashSessionId,
    source: 'POS',
    status: 'PAID',
    total,
    discount_amount: Math.min(discountAmount, ticketSubtotal()),
    created_by: session.user.id,
    items: ticket.map((i) => ({
      product_id: i.product.id,
      quantity: i.quantity,
      unit_price: i.unit_price,
      modifiers: i.modifiers,
    })),
    payment_method: selectedPaymentMethod,
  };

  let dailyNumber = null;
  try {
    if (isOnline()) {
      dailyNumber = await submitOrder(orderPayload);
    } else {
      await enqueueSync(orderPayload);
      toast('Sin conexión: venta guardada, se sincronizará al reconectar');
    }
  } catch {
    await enqueueSync(orderPayload);
    toast('Error de red: venta guardada localmente');
  }

  if (autoPrintReceipt) printSaleReceipt(ticket, total, selectedPaymentMethod, cashTendered, cashChange, dailyNumber);

  ticket = [];
  discountAmount = 0;
  renderTicket();
  el('modal-payment').classList.add('hidden');
  el('modal-payment').classList.remove('flex');
  if (selectedPaymentMethod === 'CASH') await checkCashAlert();

  if (dailyNumber != null) {
    el('order-number-display').textContent = `#${dailyNumber}`;
    if (cashChange !== null) {
      el('order-number-change').textContent = money(cashChange);
      el('order-number-change-wrap').classList.remove('hidden');
    } else {
      el('order-number-change-wrap').classList.add('hidden');
    }
    el('modal-order-number').classList.remove('hidden');
    el('modal-order-number').classList.add('flex');
  }
});

el('btn-order-number-close')?.addEventListener('click', () => {
  el('modal-order-number').classList.add('hidden');
  el('modal-order-number').classList.remove('flex');
});

function printSaleReceipt(items, total, paymentMethod, cashTendered, cashChange, dailyNumber) {
  const supplyById = Object.fromEntries(supplies.map((s) => [s.id, s]));
  const now = new Date();

  const rows = items.map((item) => {
    const modNotes = [
      ...item.modifiers.removed_ingredients.map((id) => `Sin ${supplyById[id]?.name || 'ingrediente'}`),
      ...item.modifiers.added_extras.map((e) => `+${e.qty} ${supplyById[e.ingredient_id]?.name || 'extra'}`),
    ].join(', ');
    return `
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:2px;">
        <span>${item.quantity}x ${item.product.name}</span>
        <span>${money(item.unit_price * item.quantity)}</span>
      </div>
      ${modNotes ? `<p style="font-size:11px;color:#64748b;margin:0 0 4px 12px;">${modNotes}</p>` : ''}`;
  }).join('');

  el('sale-receipt-print-view').innerHTML = `
    <div style="padding:16px;font-family:monospace;color:#0f172a;max-width:320px;margin:0 auto;">
      <h1 style="font-size:16px;font-weight:800;text-align:center;margin-bottom:2px;">${el('location-name').textContent}</h1>
      ${dailyNumber != null ? `<p style="font-size:22px;font-weight:800;text-align:center;margin-bottom:2px;">Orden #${dailyNumber}</p>` : ''}
      <p style="font-size:11px;color:#64748b;text-align:center;margin-bottom:12px;">${now.toLocaleDateString('es-MX')} ${now.toLocaleTimeString('es-MX')}</p>
      <div style="border-top:1px dashed #94a3b8;border-bottom:1px dashed #94a3b8;padding:8px 0;margin-bottom:8px;">
        ${rows}
      </div>
      ${discountAmount > 0 ? `
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px;">
        <span>Subtotal</span><span>${money(items.reduce((s, i) => s + i.unit_price * i.quantity, 0))}</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
        <span>Descuento</span><span>-${money(Math.min(discountAmount, items.reduce((s, i) => s + i.unit_price * i.quantity, 0)))}</span>
      </div>` : ''}
      <div style="display:flex;justify-content:space-between;font-size:16px;font-weight:800;margin-bottom:4px;">
        <span>Total</span><span>${money(total)}</span>
      </div>
      <p style="font-size:12px;color:#64748b;">Pago: ${paymentMethod === 'CASH' ? 'Efectivo' : 'Transferencia'}</p>
      ${paymentMethod === 'CASH' ? `
      <p style="font-size:12px;color:#64748b;">Paga con: ${money(cashTendered)}</p>
      <p style="font-size:12px;color:#64748b;">Cambio: ${money(cashChange)}</p>` : ''}
      <p style="font-size:12px;color:#64748b;">Atendió: ${session.user.username}</p>
      <p style="text-align:center;font-size:11px;color:#94a3b8;margin-top:16px;">¡Gracias por su compra!</p>
    </div>`;

  window.print();
}

async function submitOrder(payload) {
  const order = await supabasePost('orders', {
    tenant_id: payload.tenant_id,
    location_id: payload.location_id,
    cash_session_id: payload.cash_session_id,
    source: payload.source,
    status: payload.status,
    total: payload.total,
    discount_amount: payload.discount_amount || 0,
    payment_method: payload.payment_method,
    created_by: payload.created_by,
    // Sin KDS no hay flujo de cocina que pasar: se marca entregada de una vez.
    kitchen_status: kdsEnabled ? 'PENDING' : 'DELIVERED',
  });
  const orderId = order[0].id;

  for (const item of payload.items) {
    await supabasePost('order_items', { order_id: orderId, ...item });
  }

  await supabasePost('cash_transactions', {
    session_id: payload.cash_session_id,
    type: 'SALE',
    payment_method: payload.payment_method,
    amount: payload.total,
    reference_id: orderId,
  });

  toast('Venta cobrada');

  const rows = await supabaseGet(`view_kds_order_items?order_id=eq.${orderId}&select=daily_number&limit=1`);
  return rows[0]?.daily_number ?? null;
}

async function syncPendingSales() {
  if (!isOnline()) return;
  await drainSyncQueue(submitOrder);
}

// ============================================================
// AVISO DE EFECTIVO ACUMULADO EN CAJA
// ============================================================
async function checkCashAlert() {
  if (!cashSessionId || !cashAlertThreshold || !isOnline()) {
    el('cash-alert-banner').classList.add('hidden');
    el('cash-alert-banner').classList.remove('flex');
    return;
  }

  try {
    const transactions = await supabaseGet(`cash_transactions?session_id=eq.${cashSessionId}&select=type,payment_method,amount`);
    const cashInDrawer = transactions.reduce((sum, t) => {
      if (t.type === 'SALE' && t.payment_method === 'CASH') return sum + Number(t.amount);
      if (t.type === 'ADDITION') return sum + Number(t.amount);
      if (t.type === 'WITHDRAWAL') return sum - Number(t.amount);
      return sum;
    }, cashOpeningBalance);

    if (cashInDrawer >= cashAlertThreshold) {
      el('cash-alert-amount').textContent = money(cashInDrawer);
      el('cash-alert-banner').classList.remove('hidden');
      el('cash-alert-banner').classList.add('flex');
    } else {
      el('cash-alert-banner').classList.add('hidden');
      el('cash-alert-banner').classList.remove('flex');
    }
  } catch {
    // sin conexión: no se puede verificar, se deja el banner como estaba
  }
}

el('btn-dismiss-cash-alert').addEventListener('click', () => {
  el('cash-alert-banner').classList.add('hidden');
  el('cash-alert-banner').classList.remove('flex');
});

el('btn-quick-withdrawal').addEventListener('click', async () => {
  if (!cashSessionId) return;
  const amountStr = prompt('¿Cuánto efectivo vas a retirar de la caja?');
  if (amountStr === null) return;
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) return toast('Monto inválido');
  const description = prompt('¿Motivo del retiro? (opcional)') || null;

  try {
    await phpPost('cash_session.php?action=transaction', {
      session_id: cashSessionId,
      type: 'WITHDRAWAL',
      amount,
      description,
    });
    toast('Retiro registrado');
    await checkCashAlert();
    printWithdrawalVoucher(amount, description);
  } catch (err) {
    toast(err.message || 'Error al registrar el retiro');
  }
});

function printWithdrawalVoucher(amount, description) {
  const now = new Date();
  el('withdrawal-print-view').innerHTML = `
    <div style="padding:24px;font-family:sans-serif;color:#0f172a;max-width:380px;margin:0 auto;">
      <h1 style="font-size:18px;font-weight:800;text-align:center;margin-bottom:2px;">${el('location-name').textContent}</h1>
      <p style="font-size:12px;color:#64748b;text-align:center;margin-bottom:16px;">Comprobante de retiro de caja</p>
      <div style="font-size:13px;line-height:1.8;border-top:1px dashed #94a3b8;border-bottom:1px dashed #94a3b8;padding:10px 0;margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;"><span>Fecha</span><strong>${now.toLocaleDateString('es-MX')} ${now.toLocaleTimeString('es-MX')}</strong></div>
        <div style="display:flex;justify-content:space-between;"><span>Turno</span><strong>#${cashSessionId.slice(0, 8)}</strong></div>
        <div style="display:flex;justify-content:space-between;"><span>Cajero</span><strong>${session.user.username}</strong></div>
        <div style="display:flex;justify-content:space-between;"><span>Motivo</span><strong>${description || '—'}</strong></div>
      </div>
      <p style="text-align:center;font-size:26px;font-weight:900;margin-bottom:24px;">${money(amount)}</p>
      <div style="margin-top:48px;text-align:center;">
        <div style="border-top:1px solid #0f172a;width:80%;margin:0 auto;"></div>
        <p style="font-size:12px;color:#64748b;margin-top:6px;">Firma del cajero</p>
      </div>
    </div>`;
  window.print();
}
