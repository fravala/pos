// Popup táctil de modificadores: quitar ingredientes base / agregar extras
let currentProduct = null;
let currentBaseIngredients = [];
let currentAvailableExtras = [];
let removedSet = new Set();
let extrasMap = new Map(); // ingredient_id -> {qty, extra_price, name}
let resolveFn = null;

const modal = document.getElementById('modal-modifiers');
const nameEl = document.getElementById('modifiers-product-name');
const removeListEl = document.getElementById('modifiers-remove-list');
const extraListEl = document.getElementById('modifiers-extra-list');
const btnCancel = document.getElementById('btn-modifiers-cancel');
const btnAdd = document.getElementById('btn-modifiers-add');

btnCancel.addEventListener('click', () => close(null));
btnAdd.addEventListener('click', () => {
  close({
    removed_ingredients: Array.from(removedSet),
    added_extras: Array.from(extrasMap.entries()).map(([ingredient_id, v]) => ({
      ingredient_id, qty: v.qty, extra_price: v.extra_price,
    })),
  });
});

function close(result) {
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  if (resolveFn) resolveFn(result);
  resolveFn = null;
}

function renderRemoveList() {
  removeListEl.innerHTML = '';
  currentBaseIngredients.forEach((ing) => {
    const active = removedSet.has(ing.id);
    const btn = document.createElement('button');
    btn.className = `w-full flex items-center justify-between px-4 py-3 rounded-xl text-left ${
      active ? 'bg-red-50 text-red-600' : 'bg-slate-50 text-slate-700'
    }`;
    btn.innerHTML = `<span>${ing.name}</span><span class="text-xs font-semibold">${active ? 'QUITADO' : 'incluido'}</span>`;
    btn.addEventListener('click', () => {
      if (active) removedSet.delete(ing.id); else removedSet.add(ing.id);
      renderRemoveList();
    });
    removeListEl.appendChild(btn);
  });
}

function renderExtraList() {
  extraListEl.innerHTML = '';
  currentAvailableExtras.forEach((ext) => {
    const selected = extrasMap.get(ext.id);
    const row = document.createElement('div');
    row.className = `flex items-center justify-between px-4 py-3 rounded-xl ${
      selected ? 'bg-green-50 text-green-700' : 'bg-slate-50 text-slate-700'
    }`;
    row.innerHTML = `
      <span>${ext.name} <span class="text-xs text-slate-400">+$${ext.extra_price.toFixed(2)}</span></span>
      <div class="flex items-center gap-2">
        <button class="extra-minus w-9 h-9 rounded-lg bg-white shadow-sm font-bold">−</button>
        <span class="w-6 text-center font-semibold">${selected ? selected.qty : 0}</span>
        <button class="extra-plus w-9 h-9 rounded-lg bg-white shadow-sm font-bold">+</button>
      </div>`;
    row.querySelector('.extra-plus').addEventListener('click', () => {
      const cur = extrasMap.get(ext.id) || { qty: 0, extra_price: ext.extra_price, name: ext.name };
      cur.qty += 1;
      extrasMap.set(ext.id, cur);
      renderExtraList();
    });
    row.querySelector('.extra-minus').addEventListener('click', () => {
      const cur = extrasMap.get(ext.id);
      if (!cur) return;
      cur.qty -= 1;
      if (cur.qty <= 0) extrasMap.delete(ext.id); else extrasMap.set(ext.id, cur);
      renderExtraList();
    });
    extraListEl.appendChild(row);
  });
}

/**
 * Abre el popup de modificadores para un producto.
 * @param {object} product { id, name }
 * @param {Array} baseIngredients [{id, name}] — de recipes_bom
 * @param {Array} availableExtras [{id, name, extra_price}]
 * @returns {Promise<{removed_ingredients, added_extras}|null>}
 */
export function openModifiers(product, baseIngredients, availableExtras) {
  currentProduct = product;
  currentBaseIngredients = baseIngredients;
  currentAvailableExtras = availableExtras;
  removedSet = new Set();
  extrasMap = new Map();

  nameEl.textContent = product.name;
  renderRemoveList();
  renderExtraList();

  modal.classList.remove('hidden');
  modal.classList.add('flex');

  return new Promise((resolve) => { resolveFn = resolve; });
}
