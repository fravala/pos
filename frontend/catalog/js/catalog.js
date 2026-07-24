// Catálogo Web cliente — mobile-first, detecta tenant por URL, WhatsApp checkout
const SUPABASE_URL = window.__ENV__?.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = window.__ENV__?.SUPABASE_ANON_KEY || '';

const el = (id) => document.getElementById(id);
const money = (n) => `$${Number(n).toFixed(2)}`;
const toast = (msg) => {
  const t = el('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2500);
};

function getLocationId() {
  const params = new URLSearchParams(location.search);
  return params.get('location'); // ?location=<uuid> — el tenant/sucursal se resuelve por este id
}

async function supabaseGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error('Error de red');
  return res.json();
}

let locationData = null;
let products = [];
let recipes = [];
let supplies = [];
let cart = []; // [{product, quantity, unit_price, modifiers}]

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function isOpenNow(businessHours) {
  if (!businessHours) return true; // sin config = siempre abierto
  const now = new Date();
  const today = DAY_KEYS[now.getDay()];
  const hours = businessHours[today];
  if (!hours || !hours.open || !hours.close) return false;

  const [oh, om] = hours.open.split(':').map(Number);
  const [ch, cm] = hours.close.split(':').map(Number);
  const openMinutes = oh * 60 + om;
  const closeMinutes = ch * 60 + cm;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  return nowMinutes >= openMinutes && nowMinutes < closeMinutes;
}

async function init() {
  const locationId = getLocationId();
  if (!locationId) {
    el('tenant-name').textContent = 'Falta parámetro ?location=';
    return;
  }

  try {
    const locRows = await supabaseGet(`locations?id=eq.${locationId}&select=*`);
    locationData = locRows[0];
    if (!locationData) throw new Error('Negocio no encontrado');

    products = await supabaseGet(`products?tenant_id=eq.${locationData.tenant_id}&active=eq.true&select=*`);
    recipes = await supabaseGet(`recipes_bom?select=*`);
    supplies = await supabaseGet(`inventory_catalog?tenant_id=eq.${locationData.tenant_id}&select=*`);

    renderHeader();
    renderCategories();
    renderProducts(products);
    el('product-search').addEventListener('input', applyProductFilters);
  } catch (e) {
    el('tenant-name').textContent = 'No se pudo cargar el menú';
    console.error(e);
  }
}

function renderHeader() {
  document.getElementById('page-title').textContent = locationData.name;
  el('tenant-name').textContent = locationData.name;
  el('tenant-description').textContent = locationData.description || '';

  if (locationData.logo_url) {
    el('tenant-logo').src = locationData.logo_url;
    el('tenant-logo').classList.remove('hidden');
    el('tenant-icon').classList.add('hidden');
  }

  const open = isOpenNow(locationData.settings?.business_hours);
  const statusEl = el('tenant-status');
  statusEl.innerHTML = `<span class="w-1.5 h-1.5 rounded-full ${open ? 'bg-success animate-pulse' : 'bg-red-500'}"></span>${open ? 'Abierto ahora' : 'Cerrado'}`;
  statusEl.className = `text-[10px] font-bold flex items-center gap-1 ${open ? 'text-success' : 'text-red-500'}`;

  el('fab-order').disabled = !open;
  el('fab-label').textContent = open ? 'Ver Carrito' : 'Cerrado';

  requestAnimationFrame(() => {
    el('header-spacer').style.height = document.querySelector('header').offsetHeight + 'px';
  });
}

function renderCategories() {
  const cats = ['Todos', ...new Set(products.map((p) => p.category).filter(Boolean))];
  const wrap = el('category-tabs');
  wrap.innerHTML = '';
  const activeChipClass = 'whitespace-nowrap px-5 py-2 bg-primary text-white rounded-full font-label text-xs uppercase tracking-wider font-bold shadow-md shadow-primary/20';
  const inactiveChipClass = 'whitespace-nowrap px-5 py-2 bg-white text-neutral-500 border border-neutral-100 rounded-full font-label text-xs uppercase tracking-wider hover:border-primary transition-colors';
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
  requestAnimationFrame(() => {
    el('header-spacer').style.height = document.querySelector('header').offsetHeight + 'px';
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
  renderProducts(list);
}

function renderProducts(list) {
  const wrap = el('product-list');
  wrap.innerHTML = '';
  if (!list.length) {
    wrap.innerHTML = `<div class="text-center text-slate-400 py-10">Sin resultados</div>`;
    return;
  }
  list.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'bg-white rounded-xl overflow-hidden shadow-sm border border-neutral-100 active:scale-[0.98] transition-transform';
    card.innerHTML = `
      <div class="aspect-video w-full bg-neutral-200">
        ${p.image_url ? `<img src="${p.image_url}" class="w-full h-full object-cover">` : ''}
      </div>
      <div class="p-4">
        <h3 class="font-headline text-lg font-bold text-neutral-900 truncate">${p.name}</h3>
        <div class="mt-3 flex items-center justify-between">
          <span class="text-xl font-black text-neutral-900">${money(p.base_price)}</span>
          <button class="btn-add w-10 h-10 bg-primary text-white rounded-full flex items-center justify-center shadow-lg shadow-primary/30 active:scale-90 transition-transform">
            <span class="material-symbols-outlined">add</span>
          </button>
        </div>
      </div>`;
    card.querySelector('.btn-add').addEventListener('click', () => addToCart(p));
    wrap.appendChild(card);
  });
}

async function addToCart(product) {
  const supplyById = Object.fromEntries(supplies.map((s) => [s.id, s]));
  const baseIngredients = recipes
    .filter((r) => r.product_id === product.id)
    .map((r) => ({ id: r.ingredient_id, name: supplyById[r.ingredient_id]?.name || 'Insumo eliminado' }));

  const baseIds = new Set(baseIngredients.map((i) => i.id));
  const availableExtras = baseIngredients.length
    ? supplies
        .filter((s) => !baseIds.has(s.id))
        .map((s) => ({ id: s.id, name: s.name, extra_price: Number(s.unit_cost) || 0 }))
    : [];

  let modifiers = { removed_ingredients: [], added_extras: [] };
  if (baseIngredients.length || availableExtras.length) {
    const result = await openModifiers(product, baseIngredients, availableExtras);
    if (result === null) return; // el cliente canceló
    modifiers = result;
  }

  const extrasTotal = modifiers.added_extras.reduce((s, e) => s + e.extra_price * e.qty, 0);
  const unitPrice = product.base_price + extrasTotal;

  // Si tiene modificadores, siempre se agrega como línea nueva (no se fusiona con
  // otra igual) para no mezclar pedidos con distinta personalización.
  const hasMods = modifiers.removed_ingredients.length || modifiers.added_extras.length;
  const existing = !hasMods && cart.find((c) => c.product.id === product.id && !c.modifiers.removed_ingredients.length && !c.modifiers.added_extras.length);
  if (existing) existing.quantity += 1;
  else cart.push({ product, quantity: 1, unit_price: unitPrice, modifiers });

  updateFabCount();
  toast(`${product.name} agregado`);
}

// ============================================================
// MODIFICADORES: quitar ingredientes base / agregar extras con costo
// ============================================================
let modCurrentProduct = null;
let modBaseIngredients = [];
let modAvailableExtras = [];
let modRemovedSet = new Set();
let modExtrasMap = new Map();
let modResolveFn = null;

function openModifiers(product, baseIngredients, availableExtras) {
  modCurrentProduct = product;
  modBaseIngredients = baseIngredients;
  modAvailableExtras = availableExtras;
  modRemovedSet = new Set();
  modExtrasMap = new Map();

  el('modifiers-product-name').textContent = product.name;
  el('modifiers-remove-section').classList.toggle('hidden', !baseIngredients.length);
  el('modifiers-extra-section').classList.toggle('hidden', !availableExtras.length);
  renderModifiersRemoveList();
  renderModifiersExtraList();
  updateModifiersTotal();

  el('modal-modifiers').classList.remove('hidden');
  el('modal-modifiers').classList.add('flex');

  return new Promise((resolve) => { modResolveFn = resolve; });
}

function closeModifiers(result) {
  el('modal-modifiers').classList.add('hidden');
  el('modal-modifiers').classList.remove('flex');
  if (modResolveFn) modResolveFn(result);
  modResolveFn = null;
}

function renderModifiersRemoveList() {
  const wrap = el('modifiers-remove-list');
  wrap.innerHTML = '';
  modBaseIngredients.forEach((ing) => {
    const active = modRemovedSet.has(ing.id);
    const btn = document.createElement('button');
    btn.className = `w-full flex items-center justify-between px-4 py-3 rounded-xl text-left ${active ? 'bg-red-50 text-red-600' : 'bg-slate-50 text-slate-700'}`;
    btn.innerHTML = `<span>${ing.name}</span><span class="text-xs font-semibold">${active ? 'QUITADO' : 'incluido'}</span>`;
    btn.addEventListener('click', () => {
      if (active) modRemovedSet.delete(ing.id); else modRemovedSet.add(ing.id);
      renderModifiersRemoveList();
    });
    wrap.appendChild(btn);
  });
}

function renderModifiersExtraList() {
  const wrap = el('modifiers-extra-list');
  wrap.innerHTML = '';
  modAvailableExtras.forEach((ext) => {
    const selected = modExtrasMap.get(ext.id);
    const row = document.createElement('div');
    row.className = `flex items-center justify-between px-4 py-3 rounded-xl ${selected ? 'bg-green-50 text-green-700' : 'bg-slate-50 text-slate-700'}`;
    row.innerHTML = `
      <span>${ext.name} <span class="text-xs text-slate-400">+${money(ext.extra_price)}</span></span>
      <div class="flex items-center gap-2">
        <button class="extra-minus w-9 h-9 rounded-lg bg-white shadow-sm font-bold">−</button>
        <span class="w-6 text-center font-semibold">${selected ? selected.qty : 0}</span>
        <button class="extra-plus w-9 h-9 rounded-lg bg-white shadow-sm font-bold">+</button>
      </div>`;
    row.querySelector('.extra-plus').addEventListener('click', () => {
      const cur = modExtrasMap.get(ext.id) || { qty: 0, extra_price: ext.extra_price, name: ext.name };
      cur.qty += 1;
      modExtrasMap.set(ext.id, cur);
      renderModifiersExtraList();
      updateModifiersTotal();
    });
    row.querySelector('.extra-minus').addEventListener('click', () => {
      const cur = modExtrasMap.get(ext.id);
      if (!cur) return;
      cur.qty -= 1;
      if (cur.qty <= 0) modExtrasMap.delete(ext.id); else modExtrasMap.set(ext.id, cur);
      renderModifiersExtraList();
      updateModifiersTotal();
    });
    wrap.appendChild(row);
  });
}

function updateModifiersTotal() {
  const extrasTotal = Array.from(modExtrasMap.values()).reduce((s, e) => s + e.extra_price * e.qty, 0);
  el('modifiers-total-price').textContent = money(modCurrentProduct.base_price + extrasTotal);
}

el('btn-modifiers-close').addEventListener('click', () => closeModifiers(null));
el('btn-modifiers-add').addEventListener('click', () => {
  closeModifiers({
    removed_ingredients: Array.from(modRemovedSet),
    added_extras: Array.from(modExtrasMap.entries()).map(([ingredient_id, v]) => ({
      ingredient_id, qty: v.qty, extra_price: v.extra_price,
    })),
  });
});

function updateFabCount() {
  const count = cart.reduce((s, c) => s + c.quantity, 0);
  const total = cart.reduce((s, c) => s + c.unit_price * c.quantity, 0);
  el('fab-count').textContent = count;
  el('fab-total').textContent = money(total);

  const headerBadge = el('header-cart-count');
  if (count > 0) {
    headerBadge.textContent = count;
    headerBadge.classList.remove('hidden');
  } else {
    headerBadge.classList.add('hidden');
  }
}

// ============================================================
// CARRITO / CHECKOUT
// ============================================================
function openCart() {
  if (cart.length === 0) return toast('Agrega productos primero');
  renderCart();
  el('modal-cart').classList.remove('hidden');
  el('modal-cart').classList.add('flex');
}
el('fab-order').addEventListener('click', openCart);
el('btn-open-cart').addEventListener('click', openCart);

el('btn-close-cart').addEventListener('click', () => {
  el('modal-cart').classList.add('hidden');
  el('modal-cart').classList.remove('flex');
});

function renderCart() {
  const wrap = el('cart-items');
  wrap.innerHTML = '';
  cart.forEach((item, idx) => {
    const supplyById = Object.fromEntries(supplies.map((s) => [s.id, s]));
    const modNotes = [
      ...item.modifiers.removed_ingredients.map((id) => `Sin ${supplyById[id]?.name || 'ingrediente'}`),
      ...item.modifiers.added_extras.map((e) => `+${e.qty} ${supplyById[e.ingredient_id]?.name || 'extra'}`),
    ].join(', ');

    const row = document.createElement('div');
    row.className = 'flex items-center justify-between gap-2';
    row.innerHTML = `
      <div class="min-w-0">
        <span class="text-sm font-medium">${item.product.name}</span>
        ${modNotes ? `<p class="text-xs text-slate-400 truncate">${modNotes}</p>` : ''}
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <button class="qty-minus w-8 h-8 rounded-lg bg-slate-100 font-bold">−</button>
        <span class="w-6 text-center">${item.quantity}</span>
        <button class="qty-plus w-8 h-8 rounded-lg bg-slate-100 font-bold">+</button>
        <span class="w-16 text-right font-semibold">${money(item.unit_price * item.quantity)}</span>
      </div>`;
    row.querySelector('.qty-plus').addEventListener('click', () => { item.quantity += 1; renderCart(); updateFabCount(); });
    row.querySelector('.qty-minus').addEventListener('click', () => {
      item.quantity -= 1;
      if (item.quantity <= 0) cart.splice(idx, 1);
      renderCart();
      updateFabCount();
    });
    wrap.appendChild(row);
  });
  const total = cart.reduce((s, c) => s + c.unit_price * c.quantity, 0);
  el('cart-total').textContent = money(total);
}

let selectedPaymentMethod = null;
document.querySelectorAll('.payment-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    selectedPaymentMethod = btn.dataset.method;
    document.querySelectorAll('.payment-btn').forEach((b) => b.classList.remove('bg-primary', 'text-white'));
    btn.classList.add('bg-primary', 'text-white');
    el('cash-change-wrap').classList.toggle('hidden', selectedPaymentMethod !== 'CASH');
    el('btn-send-whatsapp').disabled = false;
  });
});

el('btn-send-whatsapp').addEventListener('click', () => {
  const supplyById = Object.fromEntries(supplies.map((s) => [s.id, s]));
  const total = cart.reduce((s, c) => s + c.unit_price * c.quantity, 0);
  const lines = cart.map((c) => {
    const modNotes = [
      ...c.modifiers.removed_ingredients.map((id) => `sin ${supplyById[id]?.name || 'ingrediente'}`),
      ...c.modifiers.added_extras.map((e) => `+${e.qty} ${supplyById[e.ingredient_id]?.name || 'extra'}`),
    ].join(', ');
    return `• ${c.quantity}x ${c.product.name}${modNotes ? ` (${modNotes})` : ''} — ${money(c.unit_price * c.quantity)}`;
  });

  let paymentLine = selectedPaymentMethod === 'CASH' ? 'Pago: Efectivo' : 'Pago: Transferencia';
  if (selectedPaymentMethod === 'CASH') {
    const received = parseFloat(el('cash-received').value);
    if (!isNaN(received) && received >= total) {
      paymentLine += ` (pago con ${money(received)}, cambio ${money(received - total)})`;
    }
  }

  const message = [
    `*Nuevo pedido — ${locationData.name}*`,
    ...lines,
    `Total: ${money(total)}`,
    paymentLine,
  ].join('\n');

  const phone = (locationData.whatsapp_number || '').replace(/[^0-9]/g, '');
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  window.open(url, '_blank');

  cart = [];
  updateFabCount();
  el('modal-cart').classList.add('hidden');
  el('modal-cart').classList.remove('flex');
});

init();
