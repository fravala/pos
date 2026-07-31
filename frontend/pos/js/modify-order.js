// Modificar orden ya cobrada (admin/gerente) — últimas 7 ventas
import { getSessionValue } from './db.js';
import { supabaseGet, supabasePost, supabasePatch, supabaseDelete } from './api.js';

function el(id) { return document.getElementById(id); }
const money = (n) => `$${Number(n).toFixed(2)}`;
const toast = (msg) => {
  const t = el('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2500);
};

let currentUser = null;
let currentOrder = null; // { id, total, payment_method, cash_session_id, discount_amount }
let editItems = []; // [{product_id, name, quantity, unit_price}]
let products = [];

function openModal(id) {
  el(id).classList.remove('hidden');
  el(id).classList.add('flex');
}
function closeModal(id) {
  el(id).classList.add('hidden');
  el(id).classList.remove('flex');
}

async function openModifyOrders() {
  currentUser = await getSessionValue('user');
  if (!currentUser || (currentUser.role !== 'ADMIN' && currentUser.role !== 'SUPERADMIN')) return;

  el('modify-orders-list').innerHTML = `<p class="text-sm text-slate-400">Cargando...</p>`;
  openModal('modal-modify-orders');

  const orders = await supabaseGet(
    `orders?location_id=eq.${currentUser.location_id}&status=eq.PAID&order=created_at.desc&limit=7&select=id,created_at,total,payment_method`
  );

  el('modify-orders-list').innerHTML = orders.length ? orders.map((o) => {
    const time = new Date(o.created_at).toLocaleString('es-MX', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    return `
      <button class="btn-pick-order w-full flex justify-between items-center bg-slate-50 hover:bg-slate-100 rounded-xl px-4 py-3 text-left" data-id="${o.id}">
        <span>
          <span class="block font-bold text-slate-700">#${o.id.slice(0, 8)}</span>
          <span class="block text-xs text-slate-400">${time}</span>
        </span>
        <span class="font-bold text-slate-900">${money(o.total)}</span>
      </button>`;
  }).join('') : `<p class="text-sm text-slate-400">Sin ventas recientes.</p>`;

  document.querySelectorAll('.btn-pick-order').forEach((btn) => {
    btn.addEventListener('click', () => pickOrder(btn.dataset.id));
  });
}

async function pickOrder(orderId) {
  if (!confirm('Esta orden ya fue cobrada. ¿Seguro que quieres modificarla? Esto puede ajustar el corte de caja.')) return;

  const [order] = await supabaseGet(`orders?id=eq.${orderId}&select=id,total,payment_method,cash_session_id,discount_amount`);
  const items = await supabaseGet(`order_items?order_id=eq.${orderId}&select=product_id,quantity,unit_price,products(name)`);
  if (!products.length) {
    products = await supabaseGet(`products?tenant_id=eq.${currentUser.tenant_id}&select=id,name,base_price&active=eq.true&order=name.asc`);
  }

  currentOrder = order;
  editItems = items.map((i) => ({ product_id: i.product_id, name: i.products?.name || 'Producto', quantity: Number(i.quantity), unit_price: Number(i.unit_price) }));

  el('edit-order-title').textContent = `Orden #${orderId.slice(0, 8)}`;
  el('edit-order-payment-method').value = order.payment_method || 'CASH';
  el('edit-order-add-product').innerHTML = `<option value="">Seleccionar...</option>` +
    products.map((p) => `<option value="${p.id}">${p.name} — ${money(p.base_price)}</option>`).join('');

  closeModal('modal-modify-orders');
  openModal('modal-edit-order');
  renderEditItems();
}

function renderEditItems() {
  el('edit-order-items').innerHTML = editItems.length ? editItems.map((i, idx) => `
    <div class="flex items-center justify-between bg-slate-50 rounded-lg px-3 py-2 gap-2">
      <span class="text-sm text-slate-700 flex-1 truncate">${i.name}</span>
      <button class="btn-item-dec w-7 h-7 rounded-full bg-slate-200 font-bold" data-idx="${idx}">−</button>
      <span class="w-6 text-center font-bold text-sm">${i.quantity}</span>
      <button class="btn-item-inc w-7 h-7 rounded-full bg-slate-200 font-bold" data-idx="${idx}">+</button>
      <span class="w-16 text-right font-bold text-sm">${money(i.unit_price * i.quantity)}</span>
      <button class="btn-item-remove text-red-400 text-lg leading-none" data-idx="${idx}">×</button>
    </div>`).join('') : `<p class="text-sm text-slate-400">Sin ítems.</p>`;

  document.querySelectorAll('.btn-item-inc').forEach((b) => b.addEventListener('click', () => { editItems[b.dataset.idx].quantity++; renderEditItems(); }));
  document.querySelectorAll('.btn-item-dec').forEach((b) => b.addEventListener('click', () => {
    const i = editItems[b.dataset.idx];
    i.quantity = Math.max(1, i.quantity - 1);
    renderEditItems();
  }));
  document.querySelectorAll('.btn-item-remove').forEach((b) => b.addEventListener('click', () => { editItems.splice(b.dataset.idx, 1); renderEditItems(); }));

  el('edit-order-total').textContent = money(editItemsTotal());
}

function editItemsTotal() {
  const subtotal = editItems.reduce((sum, i) => sum + i.unit_price * i.quantity, 0);
  return Math.max(0, subtotal - Number(currentOrder?.discount_amount || 0));
}

el('edit-order-add-product')?.addEventListener('change', (e) => {
  const productId = e.target.value;
  if (!productId) return;
  const product = products.find((p) => p.id === productId);
  if (!product) return;
  const existing = editItems.find((i) => i.product_id === productId);
  if (existing) existing.quantity++;
  else editItems.push({ product_id: product.id, name: product.name, quantity: 1, unit_price: Number(product.base_price) });
  e.target.value = '';
  renderEditItems();
});

el('btn-edit-order-save')?.addEventListener('click', async () => {
  if (!currentOrder) return;
  if (!editItems.length) { toast('La orden debe tener al menos un ítem'); return; }

  const newTotal = editItemsTotal();
  const oldTotal = Number(currentOrder.total);
  const diff = Math.round((newTotal - oldTotal) * 100) / 100;
  const paymentMethod = el('edit-order-payment-method').value;

  const diffMsg = diff !== 0
    ? `El total cambia de ${money(oldTotal)} a ${money(newTotal)} (ajuste de caja: ${diff > 0 ? '+' : ''}${money(diff)}).`
    : `El total se mantiene en ${money(newTotal)}.`;
  if (!confirm(`¿Guardar cambios en la orden? ${diffMsg}`)) return;

  try {
    await supabasePatch(`orders?id=eq.${currentOrder.id}`, { total: newTotal, payment_method: paymentMethod });
    await supabaseDelete(`order_items?order_id=eq.${currentOrder.id}`);
    for (const i of editItems) {
      await supabasePost('order_items', { order_id: currentOrder.id, product_id: i.product_id, quantity: i.quantity, unit_price: i.unit_price });
    }
    if (diff !== 0 && currentOrder.cash_session_id) {
      await supabasePost('cash_transactions', {
        session_id: currentOrder.cash_session_id,
        type: diff > 0 ? 'ADDITION' : 'WITHDRAWAL',
        payment_method: paymentMethod,
        amount: Math.abs(diff),
        reference_id: currentOrder.id,
        description: `Ajuste por modificación de orden #${currentOrder.id.slice(0, 8)} (${currentUser.username})`,
      });
    }
    toast('Orden actualizada');
    closeModal('modal-edit-order');
    currentOrder = null;
    editItems = [];
  } catch (err) {
    toast('Error al guardar: ' + err.message);
  }
});

el('btn-modify-order')?.addEventListener('click', openModifyOrders);
el('btn-modify-orders-close')?.addEventListener('click', () => closeModal('modal-modify-orders'));
el('btn-edit-order-close')?.addEventListener('click', () => closeModal('modal-edit-order'));
