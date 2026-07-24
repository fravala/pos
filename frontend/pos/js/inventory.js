// Panel ADMIN — CRUD de productos, insumos (inventory_catalog) y escandallo (recipes_bom)
import { getSessionValue } from './db.js';
import { supabaseGet, supabasePost, supabasePatch, supabaseDelete } from './api.js';

function el(id) { return document.getElementById(id); }
const money = (n) => `$${Number(n).toFixed(2)}`;
const price = money;

let tenantId = null;
let locationId = null;
let products = [];
let supplies = [];
let vendors = [];
let stockByCatalogId = {};
let recipesByProductId = {};
let allRecipes = [];
let productCostById = {};
let purchasesByCatalogId = {};

// ============================================================
// BOOTSTRAP + TABS
// ============================================================
export async function loadInventoryView() {
  const user = await getSessionValue('user');
  if (!user) return;
  tenantId = user.tenant_id;
  locationId = user.location_id
    ? user.location_id
    : (await supabaseGet(`locations?tenant_id=eq.${tenantId}&select=id&limit=1`))[0]?.id;

  await loadVendors();
  await loadSupplies();

  products = await supabaseGet(`products?tenant_id=eq.${tenantId}&order=name.asc&select=*`);
  await loadProductCostData();
  renderInventoryList();
  await loadDashboard();
}

// ============================================================
// COSTO/MARGEN/TENDENCIA POR PRODUCTO
// ============================================================
async function loadProductCostData() {
  const [costs, recipes, purchases] = await Promise.all([
    supabaseGet(`view_product_costs?tenant_id=eq.${tenantId}&select=*`),
    supabaseGet(`recipes_bom?select=*`),
    supabaseGet(`inventory_purchases?tenant_id=eq.${tenantId}&order=created_at.asc&select=catalog_id,created_at,unit_cost_after`),
  ]);

  productCostById = Object.fromEntries(costs.map((c) => [c.product_id, Number(c.total_cost)]));
  allRecipes = recipes;

  purchasesByCatalogId = {};
  purchases.forEach((p) => {
    if (!purchasesByCatalogId[p.catalog_id]) purchasesByCatalogId[p.catalog_id] = [];
    purchasesByCatalogId[p.catalog_id].push(p);
  });
}

/** Costo de un insumo en una fecha pasada: el ultimo unit_cost_after registrado
 * antes de esa fecha, o el mas antiguo si todas las compras son posteriores, o
 * el costo actual si nunca se registro una compra (no hay forma de saber que
 * cambio). */
function ingredientCostAt(catalogId, date) {
  const history = purchasesByCatalogId[catalogId];
  const currentCost = Number(supplies.find((s) => s.id === catalogId)?.unit_cost || 0);
  if (!history || !history.length) return currentCost;

  const before = history.filter((p) => new Date(p.created_at) <= date);
  if (before.length) return Number(before[before.length - 1].unit_cost_after);
  return Number(history[0].unit_cost_after);
}

function productCostAt(productId, date) {
  const items = allRecipes.filter((r) => r.product_id === productId);
  if (!items.length) return null;
  return items.reduce((sum, r) => sum + Number(r.quantity_to_deduct) * ingredientCostAt(r.ingredient_id, date), 0);
}

function productCostTrend(productId) {
  const current = productCostById[productId];
  if (current === undefined) return null;
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const past = productCostAt(productId, sevenDaysAgo);
  if (past === null || past <= 0) return { current, changePct: null };
  return { current, changePct: ((current - past) / past) * 100 };
}

el('tab-dashboard')?.addEventListener('click', () => switchTab('dashboard'));
el('tab-products')?.addEventListener('click', () => switchTab('products'));
el('tab-supplies')?.addEventListener('click', () => switchTab('supplies'));
el('tab-vendors')?.addEventListener('click', () => switchTab('vendors'));
el('tab-suggestions')?.addEventListener('click', () => switchTab('suggestions'));
el('tab-insights')?.addEventListener('click', () => switchTab('insights'));

function switchTab(tab) {
  const activeClass = 'inventory-tab px-5 py-2 rounded-full font-label text-xs uppercase tracking-wider font-bold bg-primary text-white shadow-md shadow-primary/20';
  const inactiveClass = 'inventory-tab px-5 py-2 rounded-full font-label text-xs uppercase tracking-wider bg-white text-neutral-500 border border-neutral-200';
  el('tab-dashboard').className = tab === 'dashboard' ? activeClass : inactiveClass;
  el('tab-products').className = tab === 'products' ? activeClass : inactiveClass;
  el('tab-supplies').className = tab === 'supplies' ? activeClass : inactiveClass;
  el('tab-vendors').className = tab === 'vendors' ? activeClass : inactiveClass;
  el('tab-suggestions').className = tab === 'suggestions' ? activeClass : inactiveClass;
  el('tab-insights').className = tab === 'insights' ? activeClass : inactiveClass;

  el('inventory-dashboard-panel').classList.toggle('hidden', tab !== 'dashboard');
  el('inventory-products-panel').classList.toggle('hidden', tab !== 'products');
  el('inventory-supplies-panel').classList.toggle('hidden', tab !== 'supplies');
  el('inventory-vendors-panel').classList.toggle('hidden', tab !== 'vendors');
  el('inventory-suggestions-panel').classList.toggle('hidden', tab !== 'suggestions');
  el('inventory-insights-panel').classList.toggle('hidden', tab !== 'insights');

  el('btn-new-product').classList.toggle('hidden', tab !== 'products');
  el('btn-new-product').classList.toggle('flex', tab === 'products');
  el('btn-import-csv').classList.toggle('hidden', tab !== 'products');
  el('btn-import-csv').classList.toggle('flex', tab === 'products');
  el('btn-new-supply').classList.toggle('hidden', tab !== 'supplies');
  el('btn-new-supply').classList.toggle('flex', tab === 'supplies');
  el('btn-new-vendor').classList.toggle('hidden', tab !== 'vendors');
  el('btn-new-vendor').classList.toggle('flex', tab === 'vendors');
  el('suggestions-actions').classList.toggle('hidden', tab !== 'suggestions');
  el('suggestions-actions').classList.toggle('flex', tab === 'suggestions');
  el('btn-update-insights').classList.toggle('hidden', tab !== 'insights');
  el('btn-update-insights').classList.toggle('flex', tab === 'insights');

  if (tab === 'dashboard') loadDashboard();
  if (tab === 'suggestions') loadSuggestions();
  if (tab === 'insights') loadInsights();
}

// ============================================================
// DASHBOARD DE VENTAS (ingresos por día/semana)
// ============================================================
async function loadDashboard() {
  if (!locationId) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (el('report-date') && !el('report-date').value) {
    el('report-date').value = today.toISOString().slice(0, 10);
  }
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 6); // hoy + 6 días atrás = 7 días

  const orders = await supabaseGet(
    `orders?location_id=eq.${locationId}&status=eq.PAID&created_at=gte.${weekAgo.toISOString()}&select=total,created_at`
  );

  const dayTotals = {}; // 'YYYY-MM-DD' -> total
  const dayKeys = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    dayKeys.push(key);
    dayTotals[key] = 0;
  }

  let todayTotal = 0;
  let todayCount = 0;
  let weekTotal = 0;
  let weekCount = 0;

  orders.forEach((o) => {
    const key = o.created_at.slice(0, 10);
    if (key in dayTotals) dayTotals[key] += Number(o.total);
    weekTotal += Number(o.total);
    weekCount += 1;
    if (key === dayKeys[6]) {
      todayTotal += Number(o.total);
      todayCount += 1;
    }
  });

  const avgTicket = weekCount > 0 ? weekTotal / weekCount : 0;

  el('dashboard-kpis').innerHTML = `
    <div class="bg-white rounded-xl border border-slate-200 p-4">
      <p class="text-xs text-slate-400 uppercase tracking-wide mb-1">Hoy</p>
      <p class="text-2xl font-black text-slate-900">${money(todayTotal)}</p>
      <p class="text-xs text-slate-400">${todayCount} ${todayCount === 1 ? 'orden' : 'órdenes'}</p>
    </div>
    <div class="bg-white rounded-xl border border-slate-200 p-4">
      <p class="text-xs text-slate-400 uppercase tracking-wide mb-1">Últimos 7 días</p>
      <p class="text-2xl font-black text-slate-900">${money(weekTotal)}</p>
      <p class="text-xs text-slate-400">${weekCount} ${weekCount === 1 ? 'orden' : 'órdenes'}</p>
    </div>
    <div class="bg-white rounded-xl border border-slate-200 p-4">
      <p class="text-xs text-slate-400 uppercase tracking-wide mb-1">Ticket promedio</p>
      <p class="text-2xl font-black text-slate-900">${money(avgTicket)}</p>
    </div>
    <div class="bg-white rounded-xl border border-slate-200 p-4">
      <p class="text-xs text-slate-400 uppercase tracking-wide mb-1">Órdenes hoy</p>
      <p class="text-2xl font-black text-slate-900">${todayCount}</p>
    </div>`;

  const maxTotal = Math.max(...dayKeys.map((k) => dayTotals[k]), 1);
  const dayLabels = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  el('dashboard-chart').innerHTML = dayKeys.map((k) => {
    const value = dayTotals[k];
    const heightPct = Math.max((value / maxTotal) * 100, value > 0 ? 4 : 0);
    const dow = new Date(k + 'T00:00:00').getDay();
    return `
      <div class="flex-1 flex flex-col items-center justify-end h-full gap-1">
        <span class="text-[10px] text-slate-500 font-semibold">${value > 0 ? money(value) : ''}</span>
        <div class="w-full bg-primary rounded-t-md" style="height: ${heightPct}%; min-height: ${value > 0 ? '4px' : '0'}"></div>
        <span class="text-[10px] text-slate-400">${dayLabels[dow]}</span>
      </div>`;
  }).join('');

  await loadPrepTimeChart(weekAgo, dayKeys, dayLabels);
}

async function loadPrepTimeChart(weekAgo, dayKeys, dayLabels) {
  const orders = await supabaseGet(
    `orders?location_id=eq.${locationId}&ready_at=not.is.null&created_at=gte.${weekAgo.toISOString()}&select=created_at,ready_at`
  );

  const dayPrepSum = {};
  const dayPrepCount = {};
  dayKeys.forEach((k) => { dayPrepSum[k] = 0; dayPrepCount[k] = 0; });

  orders.forEach((o) => {
    const key = o.created_at.slice(0, 10);
    if (!(key in dayPrepSum)) return;
    const mins = (new Date(o.ready_at) - new Date(o.created_at)) / 60000;
    dayPrepSum[key] += mins;
    dayPrepCount[key] += 1;
  });

  const dayAvg = Object.fromEntries(dayKeys.map((k) => [k, dayPrepCount[k] > 0 ? dayPrepSum[k] / dayPrepCount[k] : 0]));
  const maxAvg = Math.max(...dayKeys.map((k) => dayAvg[k]), 1);

  el('prep-time-chart').innerHTML = dayKeys.map((k) => {
    const value = dayAvg[k];
    const heightPct = Math.max((value / maxAvg) * 100, value > 0 ? 4 : 0);
    const dow = new Date(k + 'T00:00:00').getDay();
    return `
      <div class="flex-1 flex flex-col items-center justify-end h-full gap-1">
        <span class="text-[10px] text-slate-500 font-semibold">${value > 0 ? Math.round(value) + 'm' : ''}</span>
        <div class="w-full bg-secondary rounded-t-md" style="height: ${heightPct}%; min-height: ${value > 0 ? '4px' : '0'}"></div>
        <span class="text-[10px] text-slate-400">${dayLabels[dow]}</span>
      </div>`;
  }).join('');
}

// ============================================================
// REPORTE DE VENTAS IMPRIMIBLE (día específico)
// ============================================================
el('btn-print-day-report')?.addEventListener('click', async () => {
  const dateStr = el('report-date').value;
  if (!dateStr) return alert('Elige una fecha primero.');

  const dayStart = new Date(`${dateStr}T00:00:00`);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const orders = await supabaseGet(
    `orders?location_id=eq.${locationId}&status=eq.PAID&created_at=gte.${dayStart.toISOString()}&created_at=lt.${dayEnd.toISOString()}&order=created_at.asc&select=*`
  );

  const orderIds = orders.map((o) => o.id);
  const items = orderIds.length
    ? await supabaseGet(`order_items?order_id=in.(${orderIds.join(',')})&select=order_id,product_id,quantity`)
    : [];
  const itemsByOrder = {};
  items.forEach((it) => {
    if (!itemsByOrder[it.order_id]) itemsByOrder[it.order_id] = [];
    itemsByOrder[it.order_id].push(it);
  });
  const productNameById = Object.fromEntries(products.map((p) => [p.id, p.name]));

  const byMethod = { CASH: 0, TRANSFER: 0 };
  let grandTotal = 0;
  let totalDiscount = 0;

  const rows = orders.map((o, i) => {
    byMethod[o.payment_method] = (byMethod[o.payment_method] || 0) + Number(o.total);
    grandTotal += Number(o.total);
    totalDiscount += Number(o.discount_amount || 0);
    const time = new Date(o.created_at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    const itemsLabel = (itemsByOrder[o.id] || [])
      .map((it) => `${it.quantity}x ${productNameById[it.product_id] || 'Producto'}`)
      .join(', ');
    return `
      <tr>
        <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;">${i + 1}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;">${time}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;">${itemsLabel}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;">${o.payment_method === 'CASH' ? 'Efectivo' : 'Transferencia'}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #e2e8f0;text-align:right;">${money(o.total)}</td>
      </tr>`;
  }).join('');

  const dateLabel = dayStart.toLocaleDateString('es-MX', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });

  el('day-report-print-view').innerHTML = `
    <div style="padding:24px;font-family:sans-serif;color:#0f172a;">
      <h1 style="font-size:20px;font-weight:800;margin-bottom:4px;">Reporte de ventas</h1>
      <p style="font-size:13px;color:#64748b;margin-bottom:16px;text-transform:capitalize;">${dateLabel}</p>

      <div style="display:flex;gap:24px;margin-bottom:16px;font-size:13px;">
        <div><strong>${orders.length}</strong> órdenes</div>
        <div>Efectivo: <strong>${money(byMethod.CASH || 0)}</strong></div>
        <div>Transferencia: <strong>${money(byMethod.TRANSFER || 0)}</strong></div>
        <div>Descuentos: <strong>${money(totalDiscount)}</strong></div>
      </div>

      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px;">
        <thead>
          <tr style="text-align:left;background:#f1f5f9;">
            <th style="padding:4px 8px;">#</th>
            <th style="padding:4px 8px;">Hora</th>
            <th style="padding:4px 8px;">Productos</th>
            <th style="padding:4px 8px;">Pago</th>
            <th style="padding:4px 8px;text-align:right;">Total</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="5" style="padding:12px;">Sin ventas ese día</td></tr>'}</tbody>
      </table>

      <div style="display:flex;justify-content:space-between;font-size:18px;font-weight:800;border-top:2px solid #0f172a;padding-top:8px;">
        <span>Total del día</span><span>${money(grandTotal)}</span>
      </div>
    </div>`;

  window.print();
});

// ============================================================
// PRODUCTOS
// ============================================================
function renderInventoryList() {
  const wrap = el('inventory-list');
  wrap.innerHTML = '';

  if (!products.length) {
    wrap.innerHTML = `<div class="text-center text-slate-400 py-16">No hay productos todavía. Crea el primero.</div>`;
    return;
  }

  products.forEach((p) => {
    const trend = productCostTrend(p.id);
    const row = document.createElement('div');
    row.className = 'bg-white rounded-xl p-4 border border-slate-200 shadow-sm flex flex-wrap sm:flex-nowrap items-center gap-4';
    row.innerHTML = `
      ${p.image_url
        ? `<img src="${p.image_url}" class="w-16 h-16 rounded-lg object-cover shrink-0">`
        : `<div class="w-16 h-16 rounded-lg bg-slate-100 shrink-0"></div>`}
      <div class="flex-1 min-w-[140px]">
        <div class="flex items-center gap-2">
          <h3 class="font-bold text-slate-800 truncate">${p.name}</h3>
          ${!p.active ? `<span class="text-[10px] font-bold uppercase bg-slate-200 text-slate-500 px-2 py-0.5 rounded-full shrink-0">Inactivo</span>` : ''}
        </div>
        <p class="text-sm text-slate-400">${p.category || 'Sin categoría'}</p>
        ${renderCostBadge(p, trend)}
      </div>
      <div class="flex items-center justify-between gap-2 w-full sm:w-auto shrink-0">
        <span class="font-black text-primary shrink-0">${price(p.base_price)}</span>
        <div class="flex items-center gap-1 shrink-0">
          <button class="btn-recipe p-2 rounded-lg text-slate-400 hover:bg-secondary/10 hover:text-secondary transition-colors" title="Escandallo">
            <span class="material-symbols-outlined text-lg">receipt_long</span>
          </button>
          <button class="btn-edit p-2 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-primary transition-colors">
            <span class="material-symbols-outlined text-lg">edit</span>
          </button>
          <button class="btn-delete p-2 rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-500 transition-colors">
            <span class="material-symbols-outlined text-lg">delete</span>
          </button>
        </div>
      </div>`;
    row.querySelector('.btn-edit').addEventListener('click', () => openProductModal(p));
    row.querySelector('.btn-delete').addEventListener('click', () => deleteProduct(p));
    row.querySelector('.btn-recipe').addEventListener('click', () => openRecipeModal(p));
    wrap.appendChild(row);
  });
}

function renderCostBadge(product, trend) {
  if (!trend) {
    return `<p class="text-xs text-slate-300 mt-1">Sin escandallo — no se puede calcular costo/margen</p>`;
  }
  const cost = trend.current;
  const marginPct = product.base_price > 0 ? ((product.base_price - cost) / product.base_price) * 100 : 0;
  const marginTone = marginPct >= 40 ? 'text-success' : marginPct >= 20 ? 'text-warning' : 'text-red-500';

  let trendHtml = `<span class="text-slate-400">— sin cambio en 7 días</span>`;
  if (trend.changePct !== null && Math.abs(trend.changePct) >= 0.5) {
    const up = trend.changePct > 0;
    trendHtml = `<span class="${up ? 'text-red-500' : 'text-success'} font-semibold flex items-center gap-0.5">
      <span class="material-symbols-outlined text-sm">${up ? 'trending_up' : 'trending_down'}</span>
      ${up ? '+' : ''}${trend.changePct.toFixed(1)}% vs hace 7 días
    </span>`;
  }

  return `
    <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-xs">
      <span class="text-slate-500">Costo: <strong class="text-slate-700">${money(cost)}</strong></span>
      <span class="${marginTone} font-semibold">${marginPct.toFixed(0)}% margen</span>
      ${trendHtml}
    </div>`;
}

function openProductModal(product = null) {
  el('product-modal-title').textContent = product ? 'Editar producto' : 'Nuevo producto';
  el('product-id').value = product?.id || '';
  el('product-name').value = product?.name || '';
  el('product-category').value = product?.category || '';
  el('product-price').value = product?.base_price ?? '';
  el('product-image').value = product?.image_url || '';
  el('product-description').value = product?.description || '';
  el('product-active').checked = product ? product.active : true;

  el('modal-product').classList.remove('hidden');
  el('modal-product').classList.add('flex');
}

function closeProductModal() {
  el('modal-product').classList.add('hidden');
  el('modal-product').classList.remove('flex');
}

el('btn-new-product')?.addEventListener('click', () => openProductModal());
el('btn-product-cancel')?.addEventListener('click', closeProductModal);

// ============================================================
// IMPORTAR PRODUCTOS DESDE CSV (con mapeo de columnas)
// ============================================================
const IMPORT_FIELDS = [
  { key: 'name', label: 'Nombre', required: true, guesses: ['name', 'nombre', 'producto', 'product'] },
  { key: 'category', label: 'Categoría', guesses: ['category', 'categoria', 'categoría'] },
  { key: 'base_price', label: 'Precio', required: true, guesses: ['price', 'precio', 'base_price'] },
  { key: 'description', label: 'Descripción', guesses: ['description', 'descripcion', 'descripción'] },
  { key: 'image_url', label: 'Imagen (URL)', guesses: ['image', 'imagen', 'image_url', 'foto'] },
  { key: 'active', label: 'Activo (si/no)', guesses: ['active', 'activo'] },
];

let importHeaders = [];
let importRows = [];

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((f) => f.trim() !== '')) rows.push(row);
  }
  return rows;
}

function guessColumnIndex(guesses) {
  const idx = importHeaders.findIndex((h) => guesses.some((g) => h.trim().toLowerCase().includes(g)));
  return idx;
}

function openImportModal() {
  importHeaders = [];
  importRows = [];
  el('import-csv-file').value = '';
  el('import-step-mapping').classList.add('hidden');
  el('btn-import-confirm').classList.add('hidden');
  el('btn-import-confirm').classList.remove('flex');
  el('modal-import-csv').classList.remove('hidden');
  el('modal-import-csv').classList.add('flex');
}

function closeImportModal() {
  el('modal-import-csv').classList.add('hidden');
  el('modal-import-csv').classList.remove('flex');
}

el('btn-import-csv')?.addEventListener('click', openImportModal);
el('btn-import-cancel')?.addEventListener('click', closeImportModal);

el('import-csv-file')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const parsed = parseCSV(text);
  if (parsed.length < 2) return alert('El archivo no tiene filas de datos.');

  importHeaders = parsed[0];
  importRows = parsed.slice(1);
  renderImportMapping();
  renderImportPreview();
  el('import-step-mapping').classList.remove('hidden');
  el('btn-import-confirm').classList.remove('hidden');
  el('btn-import-confirm').classList.add('flex');
});

function renderImportMapping() {
  const wrap = el('import-mapping-fields');
  wrap.innerHTML = '';
  IMPORT_FIELDS.forEach((field) => {
    const guessedIdx = guessColumnIndex(field.guesses);
    const label = document.createElement('label');
    label.className = 'block';
    label.innerHTML = `
      <span class="text-sm font-semibold text-slate-500">${field.label}${field.required ? ' *' : ''}</span>
      <select class="import-field-select w-full h-11 mt-1 px-3 rounded-xl border border-slate-300 focus:border-primary focus:outline-none" data-field="${field.key}">
        <option value="-1">No importar</option>
        ${importHeaders.map((h, i) => `<option value="${i}" ${i === guessedIdx ? 'selected' : ''}>${h}</option>`).join('')}
      </select>`;
    label.querySelector('select').addEventListener('change', renderImportPreview);
    wrap.appendChild(label);
  });
}

function currentImportMapping() {
  const mapping = {};
  document.querySelectorAll('.import-field-select').forEach((sel) => {
    mapping[sel.dataset.field] = parseInt(sel.value, 10);
  });
  return mapping;
}

function renderImportPreview() {
  const mapping = currentImportMapping();
  el('import-preview-head').innerHTML = `<tr>${IMPORT_FIELDS.map((f) => `<th class="text-left p-2">${f.label}</th>`).join('')}</tr>`;
  el('import-preview-body').innerHTML = importRows.slice(0, 5).map((row) => `
    <tr class="border-t border-slate-100">
      ${IMPORT_FIELDS.map((f) => `<td class="p-2 text-slate-600">${mapping[f.key] >= 0 ? (row[mapping[f.key]] || '') : '—'}</td>`).join('')}
    </tr>`).join('');

  const validCount = importRows.filter((row) => {
    const nameIdx = mapping.name, priceIdx = mapping.base_price;
    return nameIdx >= 0 && (row[nameIdx] || '').trim() && priceIdx >= 0 && !isNaN(parseFloat(row[priceIdx]));
  }).length;
  el('import-summary').textContent = `${validCount} de ${importRows.length} filas se importarán (nombre y precio válidos requeridos).`;
}

el('btn-import-confirm')?.addEventListener('click', async () => {
  const mapping = currentImportMapping();
  if (mapping.name < 0 || mapping.base_price < 0) {
    return alert('Nombre y Precio son obligatorios: elige sus columnas.');
  }

  const toInsert = [];
  let skipped = 0;
  importRows.forEach((row) => {
    const name = (row[mapping.name] || '').trim();
    const priceRaw = mapping.base_price >= 0 ? row[mapping.base_price] : '';
    const price = parseFloat(String(priceRaw).replace(/[^0-9.-]/g, ''));
    if (!name || isNaN(price)) { skipped++; return; }

    const activeRaw = mapping.active >= 0 ? (row[mapping.active] || '').trim().toLowerCase() : '';
    const active = mapping.active >= 0 ? !['no', 'false', '0', ''].includes(activeRaw) : true;

    toInsert.push({
      tenant_id: tenantId,
      name,
      base_price: price,
      category: mapping.category >= 0 ? (row[mapping.category] || '').trim() || null : null,
      description: mapping.description >= 0 ? (row[mapping.description] || '').trim() || null : null,
      image_url: mapping.image_url >= 0 ? (row[mapping.image_url] || '').trim() || null : null,
      active,
    });
  });

  if (!toInsert.length) return alert('No hay filas válidas para importar.');

  try {
    await supabasePost('products', toInsert);
    closeImportModal();
    await loadInventoryView();
    alert(`${toInsert.length} productos importados.${skipped ? ` ${skipped} filas se saltaron por falta de nombre/precio válido.` : ''}`);
  } catch (err) {
    alert('Error al importar: ' + (err.message || 'error desconocido'));
  }
});

el('form-product')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = el('product-id').value;
  const payload = {
    name: el('product-name').value.trim(),
    category: el('product-category').value.trim() || null,
    base_price: parseFloat(el('product-price').value),
    image_url: el('product-image').value.trim() || null,
    description: el('product-description').value.trim() || null,
    active: el('product-active').checked,
  };

  if (id) {
    await supabasePatch(`products?id=eq.${id}`, payload);
  } else {
    await supabasePost('products', { ...payload, tenant_id: tenantId });
  }

  closeProductModal();
  await loadInventoryView();
});

async function deleteProduct(product) {
  if (!confirm(`¿Eliminar "${product.name}"? Esta acción no se puede deshacer.`)) return;
  try {
    await supabaseDelete(`products?id=eq.${product.id}`);
  } catch {
    // Si el producto ya tiene ventas asociadas, la FK lo bloquea: lo desactivamos en su lugar.
    await supabasePatch(`products?id=eq.${product.id}`, { active: false });
  }
  await loadInventoryView();
}

// ============================================================
// INSUMOS (inventory_catalog + inventory_stock)
// ============================================================
function populateVendorSelect() {
  const select = el('supply-vendor');
  select.innerHTML = '<option value="">Sin proveedor</option>' +
    vendors.map((v) => `<option value="${v.id}">${v.name}</option>`).join('');
}

async function loadSupplies() {
  supplies = await supabaseGet(`inventory_catalog?tenant_id=eq.${tenantId}&order=name.asc&select=*`);
  const stockRows = locationId
    ? await supabaseGet(`inventory_stock?location_id=eq.${locationId}&select=*`)
    : [];
  stockByCatalogId = Object.fromEntries(stockRows.map((s) => [s.catalog_id, s]));
  renderSuppliesList();
}

function renderSuppliesList() {
  const wrap = el('supplies-list');
  wrap.innerHTML = '';

  if (!supplies.length) {
    wrap.innerHTML = `<div class="text-center text-slate-400 py-16">No hay insumos todavía. Crea el primero.</div>`;
    return;
  }

  supplies.forEach((s) => {
    const stock = stockByCatalogId[s.id];
    const stockValue = stock ? Number(stock.current_stock) : 0;
    const isNegative = stockValue < 0;
    const vendor = vendors.find((v) => v.id === s.vendor_id);

    const row = document.createElement('div');
    row.className = 'bg-white rounded-xl p-4 border border-slate-200 shadow-sm flex items-center gap-4';
    row.innerHTML = `
      ${s.image_url
        ? `<img src="${s.image_url}" class="w-16 h-16 rounded-lg object-cover shrink-0">`
        : `<div class="w-16 h-16 rounded-lg bg-slate-100 shrink-0"></div>`}
      <div class="flex-1 min-w-0">
        <h3 class="font-bold text-slate-800 truncate">${s.name}</h3>
        <p class="text-sm text-slate-400">
          ${s.restock_mode === 'VENDOR_ROUTE' ? `Proveedor: ${vendor?.name || 'sin asignar'}` : 'Compra propia'}
          · ${s.purchase_label ? `${s.purchase_label} (${money(s.purchase_unit_cost)})` : `${money(s.unit_cost)}/${s.unit_measurement}`}
        </p>
      </div>
      <div class="text-right shrink-0">
        <p class="text-xs text-slate-400 uppercase tracking-wide">Stock</p>
        <p class="font-black ${isNegative ? 'text-red-500' : 'text-slate-800'}">${stockValue} ${s.unit_measurement}</p>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <button class="btn-purchase p-2 rounded-lg text-slate-400 hover:bg-secondary/10 hover:text-secondary transition-colors" title="Registrar compra">
          <span class="material-symbols-outlined text-lg">local_shipping</span>
        </button>
        <button class="btn-history p-2 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors" title="Historial de compras">
          <span class="material-symbols-outlined text-lg">history</span>
        </button>
        <button class="btn-edit p-2 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-primary transition-colors">
          <span class="material-symbols-outlined text-lg">edit</span>
        </button>
        <button class="btn-delete p-2 rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-500 transition-colors">
          <span class="material-symbols-outlined text-lg">delete</span>
        </button>
      </div>`;
    row.querySelector('.btn-purchase').addEventListener('click', () => openPurchaseModal(s));
    row.querySelector('.btn-history').addEventListener('click', () => openHistoryModal(s));
    row.querySelector('.btn-edit').addEventListener('click', () => openSupplyModal(s));
    row.querySelector('.btn-delete').addEventListener('click', () => deleteSupply(s));
    wrap.appendChild(row);
  });
}

function openSupplyModal(supply = null) {
  el('supply-modal-title').textContent = supply ? 'Editar insumo' : 'Nuevo insumo';
  el('supply-id').value = supply?.id || '';
  el('supply-name').value = supply?.name || '';
  el('supply-unit').value = supply?.unit_measurement || 'unit';
  el('supply-purchase-label').value = supply?.purchase_label || '';
  el('supply-purchase-size').value = supply?.purchase_unit_size ?? 1;
  el('supply-purchase-cost').value = supply?.purchase_unit_cost ?? (supply?.unit_cost ?? '');
  el('supply-restock-mode').value = supply?.restock_mode || 'SELF_PURCHASE';
  el('supply-vendor').value = supply?.vendor_id || '';
  el('supply-lead-time').value = supply?.self_purchase_lead_time ?? '';
  el('supply-image').value = supply?.image_url || '';

  el('supply-purchase-hint').textContent = supply ? '(referencia)' : '(costo inicial)';
  el('supply-purchase-warning').classList.toggle('hidden', !supply);

  const purchaseSize = parseFloat(el('supply-purchase-size').value) || 1;
  const hasPresentation = purchaseSize > 1;
  const baseStock = stockByCatalogId[supply?.id]?.current_stock ?? 0;
  const baseSafety = stockByCatalogId[supply?.id]?.safety_stock ?? 0;

  el('supply-stock-unit-mode').value = hasPresentation ? 'purchase' : 'base';
  el('supply-safety-unit-mode').value = hasPresentation ? 'purchase' : 'base';
  el('supply-stock-qty').value = hasPresentation ? +(baseStock / purchaseSize).toFixed(4) : baseStock;
  el('supply-safety-qty').value = hasPresentation ? +(baseSafety / purchaseSize).toFixed(4) : baseSafety;

  updateUnitLabels();
  updateComputedUnitCost();
  updateStockEquivalence();

  el('modal-supply').classList.remove('hidden');
  el('modal-supply').classList.add('flex');
}

function updateUnitLabels() {
  const unit = el('supply-unit').value;
  const label = el('supply-purchase-label').value.trim();
  ['supply-unit-label-1', 'supply-unit-label-2', 'supply-unit-label-3'].forEach((id) => {
    el(id).textContent = id === 'supply-unit-label-1' ? `(${unit})` : unit;
  });
  [el('supply-stock-unit-mode'), el('supply-safety-unit-mode')].forEach((sel) => {
    sel.options[0].textContent = label || 'presentación de compra';
    sel.options[1].textContent = `unidad base (${unit})`;
  });
}

function updateComputedUnitCost() {
  const size = parseFloat(el('supply-purchase-size').value) || 0;
  const cost = parseFloat(el('supply-purchase-cost').value) || 0;
  const unitCost = size > 0 ? cost / size : 0;
  el('supply-computed-unit-cost').textContent = money(unitCost);
}

function stockQtyToBase(qty, mode) {
  const size = parseFloat(el('supply-purchase-size').value) || 1;
  return mode === 'purchase' ? qty * size : qty;
}

function updateStockEquivalence() {
  const qty = parseFloat(el('supply-stock-qty').value) || 0;
  const mode = el('supply-stock-unit-mode').value;
  el('supply-stock-equiv').textContent = +stockQtyToBase(qty, mode).toFixed(4);
}

el('supply-unit')?.addEventListener('change', updateUnitLabels);
el('supply-purchase-label')?.addEventListener('input', updateUnitLabels);
el('supply-purchase-size')?.addEventListener('input', () => { updateComputedUnitCost(); updateStockEquivalence(); });
el('supply-purchase-cost')?.addEventListener('input', updateComputedUnitCost);
el('supply-stock-qty')?.addEventListener('input', updateStockEquivalence);
el('supply-stock-unit-mode')?.addEventListener('change', updateStockEquivalence);

function closeSupplyModal() {
  el('modal-supply').classList.add('hidden');
  el('modal-supply').classList.remove('flex');
}

el('btn-new-supply')?.addEventListener('click', () => openSupplyModal());
el('btn-supply-cancel')?.addEventListener('click', closeSupplyModal);

el('form-supply')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = el('supply-id').value;
  const purchaseSize = parseFloat(el('supply-purchase-size').value) || 1;
  const purchaseCost = parseFloat(el('supply-purchase-cost').value) || 0;
  const payload = {
    name: el('supply-name').value.trim(),
    unit_measurement: el('supply-unit').value,
    purchase_label: el('supply-purchase-label').value.trim() || null,
    purchase_unit_size: purchaseSize,
    purchase_unit_cost: purchaseCost,
    restock_mode: el('supply-restock-mode').value,
    vendor_id: el('supply-vendor').value || null,
    self_purchase_lead_time: el('supply-lead-time').value ? parseInt(el('supply-lead-time').value, 10) : null,
    image_url: el('supply-image').value.trim() || null,
  };
  // El costo promedio (unit_cost) solo se fija al crear el insumo. Editarlo después
  // NO debe cambiarlo — eso distorsionaría el costeo de recetas ya calculado con
  // el stock existente. Para dar entrada a compras nuevas usa "Registrar compra".
  if (!id) {
    payload.unit_cost = purchaseSize > 0 ? purchaseCost / purchaseSize : 0;
  }

  let catalogId = id;
  if (id) {
    await supabasePatch(`inventory_catalog?id=eq.${id}`, payload);
  } else {
    const created = await supabasePost('inventory_catalog', { ...payload, tenant_id: tenantId });
    catalogId = created[0].id;
  }

  if (locationId) {
    const stockQty = parseFloat(el('supply-stock-qty').value) || 0;
    const safetyQty = parseFloat(el('supply-safety-qty').value) || 0;
    const stockPayload = {
      catalog_id: catalogId,
      location_id: locationId,
      current_stock: stockQtyToBase(stockQty, el('supply-stock-unit-mode').value),
      safety_stock: stockQtyToBase(safetyQty, el('supply-safety-unit-mode').value),
    };
    if (stockByCatalogId[catalogId]) {
      await supabasePatch(`inventory_stock?catalog_id=eq.${catalogId}&location_id=eq.${locationId}`, {
        current_stock: stockPayload.current_stock,
        safety_stock: stockPayload.safety_stock,
      });
    } else {
      await supabasePost('inventory_stock', stockPayload);
      // Registra el alta inicial como la primera "compra" del historial, para que
      // editar/borrar compras después pueda recalcular el ledger completo desde cero.
      if (stockPayload.current_stock > 0) {
        await supabasePost('inventory_purchases', {
          tenant_id: tenantId,
          catalog_id: catalogId,
          location_id: locationId,
          purchase_label: payload.purchase_label || 'Alta inicial',
          purchase_unit_size: stockPayload.current_stock,
          quantity_purchased: 1,
          quantity_base: stockPayload.current_stock,
          total_cost: stockPayload.current_stock * (payload.unit_cost || 0),
          unit_cost_after: payload.unit_cost || 0,
        });
      }
    }
  }

  closeSupplyModal();
  await loadSupplies();
  await loadProductCostData();
  renderInventoryList();
});

// ============================================================
// REGISTRAR COMPRA (inventory_purchases + costo promedio ponderado)
// ============================================================
let currentPurchaseSupply = null;

function openPurchaseModal(supply) {
  currentPurchaseSupply = supply;
  el('purchase-supply-name').textContent = supply.name;
  el('purchase-unit-label').textContent = `(${supply.unit_measurement})`;
  el('purchase-label').value = supply.purchase_label || '';
  el('purchase-unit-size').value = supply.purchase_unit_size || 1;
  el('purchase-qty').value = 1;
  el('purchase-total-cost').value = supply.purchase_unit_cost || '';

  updatePurchasePreview();

  el('modal-purchase').classList.remove('hidden');
  el('modal-purchase').classList.add('flex');
}

function closePurchaseModal() {
  el('modal-purchase').classList.add('hidden');
  el('modal-purchase').classList.remove('flex');
}

function updatePurchasePreview() {
  const supply = currentPurchaseSupply;
  if (!supply) return;
  const oldStock = Number(stockByCatalogId[supply.id]?.current_stock || 0);
  const oldCost = Number(supply.unit_cost || 0);

  const size = parseFloat(el('purchase-unit-size').value) || 0;
  const qty = parseFloat(el('purchase-qty').value) || 0;
  const totalCost = parseFloat(el('purchase-total-cost').value) || 0;
  const qtyBase = size * qty;

  const oldValue = oldStock * oldCost;
  const newStock = oldStock + qtyBase;
  const newCost = newStock > 0 ? (oldValue + totalCost) / newStock : 0;

  el('purchase-preview-old-stock').textContent = `${oldStock} ${supply.unit_measurement}`;
  el('purchase-preview-old-cost').textContent = money(oldCost);
  el('purchase-preview-new-stock').textContent = `${+newStock.toFixed(4)} ${supply.unit_measurement}`;
  el('purchase-preview-new-cost').textContent = money(newCost);
}

['purchase-unit-size', 'purchase-qty', 'purchase-total-cost'].forEach((id) => {
  el(id)?.addEventListener('input', updatePurchasePreview);
});
el('btn-purchase-cancel')?.addEventListener('click', closePurchaseModal);

el('form-purchase')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const supply = currentPurchaseSupply;
  if (!supply || !locationId) return;

  const size = parseFloat(el('purchase-unit-size').value) || 1;
  const qty = parseFloat(el('purchase-qty').value) || 0;
  const totalCost = parseFloat(el('purchase-total-cost').value) || 0;
  const label = el('purchase-label').value.trim() || null;

  if (qty <= 0 || totalCost < 0) return;

  const qtyBase = size * qty;
  const oldStock = Number(stockByCatalogId[supply.id]?.current_stock || 0);
  const oldCost = Number(supply.unit_cost || 0);
  const newStock = oldStock + qtyBase;
  const newCost = newStock > 0 ? (oldStock * oldCost + totalCost) / newStock : 0;

  await supabasePost('inventory_purchases', {
    tenant_id: tenantId,
    catalog_id: supply.id,
    location_id: locationId,
    purchase_label: label,
    purchase_unit_size: size,
    quantity_purchased: qty,
    quantity_base: qtyBase,
    total_cost: totalCost,
    unit_cost_after: newCost,
  });

  if (stockByCatalogId[supply.id]) {
    await supabasePatch(`inventory_stock?catalog_id=eq.${supply.id}&location_id=eq.${locationId}`, {
      current_stock: newStock,
    });
  } else {
    await supabasePost('inventory_stock', {
      catalog_id: supply.id,
      location_id: locationId,
      current_stock: newStock,
      safety_stock: 0,
    });
  }

  await supabasePatch(`inventory_catalog?id=eq.${supply.id}`, {
    unit_cost: newCost,
    purchase_label: label,
    purchase_unit_size: size,
    purchase_unit_cost: qty > 0 ? totalCost / qty : 0,
  });

  closePurchaseModal();
  await loadSupplies();
  await loadProductCostData();
  renderInventoryList();
});

// ============================================================
// HISTORIAL DE COMPRAS (ver / editar / borrar + recálculo del ledger)
// ============================================================
let currentHistorySupply = null;

async function openHistoryModal(supply) {
  currentHistorySupply = supply;
  el('history-supply-name').textContent = supply.name;
  await renderHistoryList();
  el('modal-history').classList.remove('hidden');
  el('modal-history').classList.add('flex');
}

el('btn-history-close')?.addEventListener('click', () => {
  el('modal-history').classList.add('hidden');
  el('modal-history').classList.remove('flex');
});

async function renderHistoryList() {
  const supply = currentHistorySupply;
  const purchases = await supabaseGet(
    `inventory_purchases?catalog_id=eq.${supply.id}&location_id=eq.${locationId}&order=created_at.asc&select=*`
  );

  const wrap = el('history-list');
  wrap.innerHTML = '';

  if (!purchases.length) {
    wrap.innerHTML = `<p class="text-sm text-slate-400 py-6 text-center">Sin compras registradas todavía.</p>`;
    return;
  }

  purchases.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'bg-slate-50 rounded-xl p-3 space-y-2';
    row.innerHTML = `
      <div class="flex items-center justify-between gap-2">
        <input class="hist-label flex-1 h-9 px-2 rounded-lg border border-slate-200 text-sm" value="${p.purchase_label || ''}" placeholder="Presentación">
        <span class="text-xs text-slate-400">${new Date(p.created_at).toLocaleDateString('es-MX')}</span>
      </div>
      <div class="grid grid-cols-3 gap-2 items-end">
        <label class="block">
          <span class="text-[11px] text-slate-400">Cantidad (${supply.unit_measurement})</span>
          <input class="hist-qtybase w-full h-9 px-2 rounded-lg border border-slate-200 text-sm" type="number" step="0.0001" value="${p.quantity_base}">
        </label>
        <label class="block">
          <span class="text-[11px] text-slate-400">Costo total</span>
          <input class="hist-cost w-full h-9 px-2 rounded-lg border border-slate-200 text-sm" type="number" step="0.01" value="${p.total_cost}">
        </label>
        <div class="flex gap-1">
          <button class="btn-hist-save flex-1 h-9 rounded-lg bg-secondary text-white text-xs font-bold">Guardar</button>
          <button class="btn-hist-delete w-9 h-9 rounded-lg bg-white border border-red-200 text-red-500 flex items-center justify-center">
            <span class="material-symbols-outlined text-base">delete</span>
          </button>
        </div>
      </div>
      <p class="text-[11px] text-slate-400">Costo promedio resultante en su momento: ${money(p.unit_cost_after)}/${supply.unit_measurement}</p>`;

    row.querySelector('.btn-hist-save').addEventListener('click', async () => {
      const newQtyBase = parseFloat(row.querySelector('.hist-qtybase').value) || 0;
      const newTotalCost = parseFloat(row.querySelector('.hist-cost').value) || 0;
      const label = row.querySelector('.hist-label').value.trim() || null;
      await applyLedgerDelta(supply, {
        deltaQty: newQtyBase - Number(p.quantity_base),
        deltaCost: newTotalCost - Number(p.total_cost),
      });
      await supabasePatch(`inventory_purchases?id=eq.${p.id}`, {
        purchase_label: label,
        quantity_base: newQtyBase,
        quantity_purchased: newQtyBase,
        purchase_unit_size: 1,
        total_cost: newTotalCost,
      });
      await renderHistoryList();
      await loadSupplies();
      await loadProductCostData();
      renderInventoryList();
    });

    row.querySelector('.btn-hist-delete').addEventListener('click', async () => {
      if (!confirm('¿Eliminar esta compra del historial? Se descontará su cantidad del stock actual.')) return;
      await applyLedgerDelta(supply, {
        deltaQty: -Number(p.quantity_base),
        deltaCost: -Number(p.total_cost),
      });
      await supabaseDelete(`inventory_purchases?id=eq.${p.id}`);
      await renderHistoryList();
      await loadSupplies();
      await loadProductCostData();
      renderInventoryList();
    });

    wrap.appendChild(row);
  });
}

/** Aplica el efecto de editar/borrar UNA compra sobre el stock y costo promedio
 * actuales, por diferencia (delta) — nunca recalcula desde cero. Esto evita
 * pisar stock/costo que viene de ventas ya hechas o de altas anteriores a esta
 * compra, que no están en el ledger de compras. */
async function applyLedgerDelta(supply, { deltaQty, deltaCost }) {
  const stockRow = stockByCatalogId[supply.id];
  const oldStock = Number(stockRow?.current_stock || 0);
  const oldCost = Number(supply.unit_cost || 0);
  const oldValue = oldStock * oldCost;

  const newStock = oldStock + deltaQty;
  const newValue = oldValue + deltaCost;
  const newCost = newStock > 0 ? newValue / newStock : 0;

  if (stockRow) {
    await supabasePatch(`inventory_stock?catalog_id=eq.${supply.id}&location_id=eq.${locationId}`, {
      current_stock: newStock,
    });
  }
  await supabasePatch(`inventory_catalog?id=eq.${supply.id}`, { unit_cost: newCost });

  // refleja el cambio localmente para que si se edita otra fila del mismo
  // historial en la misma sesión, el delta siguiente parta de valores frescos
  supply.unit_cost = newCost;
  if (stockRow) stockRow.current_stock = newStock;
}

async function deleteSupply(supply) {
  if (!confirm(`¿Eliminar insumo "${supply.name}"? Esto también quita su uso en escandallos.`)) return;
  try {
    await supabaseDelete(`inventory_catalog?id=eq.${supply.id}`);
  } catch {
    alert('No se puede eliminar: este insumo tiene movimientos o escandallos asociados.');
    return;
  }
  await loadSupplies();
}

// ============================================================
// ESCANDALLO (recipes_bom)
// ============================================================
let currentRecipeProduct = null;

async function openRecipeModal(product) {
  currentRecipeProduct = product;
  el('recipe-product-name').textContent = product.name;

  const rows = await supabaseGet(`recipes_bom?product_id=eq.${product.id}&select=*`);
  recipesByProductId[product.id] = rows;

  const supplySelect = el('recipe-add-supply');
  supplySelect.innerHTML = supplies.map((s) => `<option value="${s.id}">${s.name} (${s.unit_measurement})</option>`).join('');

  renderRecipeList();

  el('modal-recipe').classList.remove('hidden');
  el('modal-recipe').classList.add('flex');
}

function renderRecipeList() {
  const rows = recipesByProductId[currentRecipeProduct.id] || [];
  const wrap = el('recipe-list');
  wrap.innerHTML = '';

  if (!rows.length) {
    wrap.innerHTML = `<p class="text-sm text-slate-400 py-4 text-center">Sin insumos asignados todavía.</p>`;
    return;
  }

  rows.forEach((r) => {
    const supply = supplies.find((s) => s.id === r.ingredient_id);
    const item = document.createElement('div');
    item.className = 'flex items-center justify-between bg-slate-50 rounded-lg p-3';
    item.innerHTML = `
      <span class="text-sm font-semibold text-slate-700">${supply?.name || 'Insumo eliminado'}</span>
      <div class="flex items-center gap-3">
        <span class="text-sm text-slate-500">${r.quantity_to_deduct} ${supply?.unit_measurement || ''}</span>
        <button class="btn-remove-recipe text-red-400 hover:text-red-500">
          <span class="material-symbols-outlined text-lg">delete</span>
        </button>
      </div>`;
    item.querySelector('.btn-remove-recipe').addEventListener('click', async () => {
      await supabaseDelete(`recipes_bom?id=eq.${r.id}`);
      recipesByProductId[currentRecipeProduct.id] = (recipesByProductId[currentRecipeProduct.id] || []).filter((x) => x.id !== r.id);
      renderRecipeList();
      await loadProductCostData();
      renderInventoryList();
    });
    wrap.appendChild(item);
  });
}

el('btn-recipe-add')?.addEventListener('click', async () => {
  const ingredientId = el('recipe-add-supply').value;
  const qty = parseFloat(el('recipe-add-qty').value);
  if (!ingredientId || !qty || qty <= 0) return;

  const created = await supabasePost('recipes_bom', {
    product_id: currentRecipeProduct.id,
    ingredient_id: ingredientId,
    quantity_to_deduct: qty,
  });
  recipesByProductId[currentRecipeProduct.id] = [...(recipesByProductId[currentRecipeProduct.id] || []), created[0]];
  el('recipe-add-qty').value = '';
  renderRecipeList();
  await loadProductCostData();
  renderInventoryList();
});

el('btn-recipe-close')?.addEventListener('click', () => {
  el('modal-recipe').classList.add('hidden');
  el('modal-recipe').classList.remove('flex');
});

// ============================================================
// PROVEEDORES (vendors)
// ============================================================
async function loadVendors() {
  vendors = await supabaseGet(`vendors?tenant_id=eq.${tenantId}&order=name.asc&select=*`);
  populateVendorSelect();
  renderVendorsList();
}

function renderVendorsList() {
  const wrap = el('vendors-list');
  wrap.innerHTML = '';

  if (!vendors.length) {
    wrap.innerHTML = `<div class="text-center text-slate-400 py-16">No hay proveedores todavía. Crea el primero.</div>`;
    return;
  }

  vendors.forEach((v) => {
    const contact = v.contact_info || {};
    const row = document.createElement('div');
    row.className = 'bg-white rounded-xl p-4 border border-slate-200 shadow-sm flex items-center gap-4';
    row.innerHTML = `
      <div class="w-12 h-12 rounded-full bg-secondary/10 text-secondary flex items-center justify-center shrink-0">
        <span class="material-symbols-outlined">local_shipping</span>
      </div>
      <div class="flex-1 min-w-0">
        <h3 class="font-bold text-slate-800 truncate">${v.name}</h3>
        <p class="text-sm text-slate-400">${[contact.phone, contact.email].filter(Boolean).join(' · ') || 'Sin datos de contacto'}</p>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <button class="btn-edit p-2 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-primary transition-colors">
          <span class="material-symbols-outlined text-lg">edit</span>
        </button>
        <button class="btn-delete p-2 rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-500 transition-colors">
          <span class="material-symbols-outlined text-lg">delete</span>
        </button>
      </div>`;
    row.querySelector('.btn-edit').addEventListener('click', () => openVendorModal(v));
    row.querySelector('.btn-delete').addEventListener('click', () => deleteVendor(v));
    wrap.appendChild(row);
  });
}

function openVendorModal(vendor = null) {
  el('vendor-modal-title').textContent = vendor ? 'Editar proveedor' : 'Nuevo proveedor';
  el('vendor-id').value = vendor?.id || '';
  el('vendor-name').value = vendor?.name || '';
  el('vendor-phone').value = vendor?.contact_info?.phone || '';
  el('vendor-email').value = vendor?.contact_info?.email || '';

  el('modal-vendor').classList.remove('hidden');
  el('modal-vendor').classList.add('flex');
}

function closeVendorModal() {
  el('modal-vendor').classList.add('hidden');
  el('modal-vendor').classList.remove('flex');
}

el('btn-new-vendor')?.addEventListener('click', () => openVendorModal());
el('btn-vendor-cancel')?.addEventListener('click', closeVendorModal);

el('form-vendor')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = el('vendor-id').value;
  const payload = {
    name: el('vendor-name').value.trim(),
    contact_info: {
      phone: el('vendor-phone').value.trim() || null,
      email: el('vendor-email').value.trim() || null,
    },
  };

  if (id) {
    await supabasePatch(`vendors?id=eq.${id}`, payload);
  } else {
    await supabasePost('vendors', { ...payload, tenant_id: tenantId });
  }

  closeVendorModal();
  await loadVendors();
});

async function deleteVendor(vendor) {
  if (!confirm(`¿Eliminar proveedor "${vendor.name}"?`)) return;
  try {
    await supabaseDelete(`vendors?id=eq.${vendor.id}`);
  } catch {
    alert('No se puede eliminar: hay insumos o sugerencias de compra asignados a este proveedor.');
    return;
  }
  await loadVendors();
}

// ============================================================
// SUGERENCIAS DE COMPRA (purchase_suggestions, generadas por ML)
// ============================================================
const ML_SERVICE_URL = window.__ENV__?.ML_SERVICE_URL || 'http://localhost:8001';

let currentSuggestions = [];

async function loadSuggestions() {
  currentSuggestions = await supabaseGet(
    `purchase_suggestions?tenant_id=eq.${tenantId}&status=eq.PENDING&order=created_at.desc&select=*`
  );
  renderSuggestionsList(currentSuggestions);
}

function suggestionQtyLabel(s, supply) {
  if (!supply) return `${s.suggested_qty}`;
  if (supply.purchase_label && supply.purchase_unit_size > 0) {
    const packages = Math.ceil(s.suggested_qty / supply.purchase_unit_size);
    return `${packages} × ${supply.purchase_label} (${s.suggested_qty} ${supply.unit_measurement})`;
  }
  return `${s.suggested_qty} ${supply.unit_measurement}`;
}

function renderSuggestionsList(suggestions) {
  const wrap = el('suggestions-list');
  wrap.innerHTML = '';

  if (!suggestions.length) {
    wrap.innerHTML = `<div class="text-center text-slate-400 py-16">Sin sugerencias pendientes. Usa "Recalcular inventario" para generar nuevas.</div>`;
    return;
  }

  suggestions.forEach((s) => {
    const supply = supplies.find((x) => x.id === s.catalog_id);
    const vendor = vendors.find((v) => v.id === s.vendor_id);
    const row = document.createElement('div');
    row.className = 'bg-white rounded-xl p-4 border border-slate-200 shadow-sm flex items-center gap-4';
    row.innerHTML = `
      <div class="w-12 h-12 rounded-full bg-warning/10 text-warning flex items-center justify-center shrink-0">
        <span class="material-symbols-outlined">shopping_cart</span>
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <h3 class="font-bold text-slate-800">${supply?.name || 'Insumo'}</h3>
          <span class="text-[10px] font-bold uppercase bg-warning/10 text-warning px-2 py-0.5 rounded-full">
            ${s.restock_mode === 'VENDOR_ROUTE' ? vendor?.name || 'Proveedor' : 'Compra propia'}
          </span>
        </div>
        <p class="text-sm text-slate-400">${s.reasoning || ''}</p>
      </div>
      <span class="font-black text-slate-800 shrink-0 text-right">${suggestionQtyLabel(s, supply)}</span>
      <div class="flex items-center gap-1 shrink-0">
        <button class="btn-resolve p-2 rounded-lg text-slate-400 hover:bg-success/10 hover:text-success transition-colors" title="Marcar atendida">
          <span class="material-symbols-outlined text-lg">check_circle</span>
        </button>
        <button class="btn-dismiss p-2 rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-500 transition-colors" title="Descartar">
          <span class="material-symbols-outlined text-lg">close</span>
        </button>
      </div>`;
    row.querySelector('.btn-resolve').addEventListener('click', () => resolveSuggestion(s, 'RESOLVED'));
    row.querySelector('.btn-dismiss').addEventListener('click', () => resolveSuggestion(s, 'DISMISSED'));
    wrap.appendChild(row);
  });
}

async function resolveSuggestion(suggestion, status) {
  await supabasePatch(`purchase_suggestions?id=eq.${suggestion.id}`, { status });
  await loadSuggestions();
}

el('btn-recalculate-inventory')?.addEventListener('click', async () => {
  const btn = el('btn-recalculate-inventory');
  const label = el('btn-recalculate-label');
  btn.disabled = true;
  label.textContent = 'Calculando...';
  try {
    const res = await fetch(`${ML_SERVICE_URL}/recalculate-inventory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location_id: locationId }),
    });
    if (!res.ok) throw new Error('Error del servicio ML');
    await loadSuggestions();
    label.textContent = 'Recalcular inventario';
  } catch (e) {
    label.textContent = 'Recalcular inventario';
    alert('No se pudo conectar con el servicio de predicción (ml-service). ¿Está corriendo?');
  } finally {
    btn.disabled = false;
  }
});

// ============================================================
// EXPORTAR SUGERENCIAS: imprimir / PDF / WhatsApp
// ============================================================
function buildSuggestionsSummary() {
  const today = new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' });
  const lines = currentSuggestions.map((s) => {
    const supply = supplies.find((x) => x.id === s.catalog_id);
    const vendor = vendors.find((v) => v.id === s.vendor_id);
    const source = s.restock_mode === 'VENDOR_ROUTE' ? (vendor?.name || 'Proveedor') : 'Compra propia';
    return { name: supply?.name || 'Insumo', qty: suggestionQtyLabel(s, supply), source };
  });
  return { today, lines };
}

el('btn-print-suggestions')?.addEventListener('click', () => {
  const { today, lines } = buildSuggestionsSummary();
  const rows = lines.map((l) => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;">${l.name}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;">${l.qty}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;">${l.source}</td>
    </tr>`).join('');

  el('suggestions-print-view').innerHTML = `
    <div style="padding:24px;font-family:sans-serif;color:#0f172a;">
      <h1 style="font-size:20px;font-weight:800;margin-bottom:4px;">Lista de compras</h1>
      <p style="font-size:13px;color:#64748b;margin-bottom:16px;">${today}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <thead>
          <tr style="text-align:left;background:#f1f5f9;">
            <th style="padding:6px 8px;">Insumo</th>
            <th style="padding:6px 8px;">Cantidad a comprar</th>
            <th style="padding:6px 8px;">Dónde</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="3" style="padding:12px;">Sin pendientes</td></tr>'}</tbody>
      </table>
    </div>`;

  window.print();
});

el('btn-whatsapp-suggestions')?.addEventListener('click', () => {
  const { today, lines } = buildSuggestionsSummary();
  if (!lines.length) return alert('No hay sugerencias pendientes para enviar.');

  const text = [
    `*Lista de compras — ${today}*`,
    ...lines.map((l) => `• ${l.name}: ${l.qty} (${l.source})`),
  ].join('\n');

  window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`, '_blank');
});

// ============================================================
// INSIGHTS (weekly_sales_analytics: matriz ABC + cross-selling, generados por ML)
// ============================================================
async function loadInsights() {
  const rows = await supabaseGet(
    `weekly_sales_analytics?tenant_id=eq.${tenantId}&order=week_start.desc&limit=1&select=*`
  );
  renderInsights(rows[0] || null);
}

function renderInsights(analytics) {
  const abcWrap = el('abc-matrix-list');
  const comboWrap = el('cross-selling-list');
  abcWrap.innerHTML = '';
  comboWrap.innerHTML = '';

  const abcMatrix = analytics?.abc_matrix || [];
  const combos = analytics?.cross_selling_combos || [];

  if (!analytics) {
    abcWrap.innerHTML = `<div class="text-center text-slate-400 py-10">Sin datos todavía. Usa "Actualizar insights" para generarlos.</div>`;
    comboWrap.innerHTML = '';
    return;
  }

  const classTone = { A: 'bg-success/10 text-success', B: 'bg-warning/10 text-warning', C: 'bg-red-50 text-red-500' };

  if (!abcMatrix.length) {
    abcWrap.innerHTML = `<div class="text-center text-slate-400 py-6">Sin ventas suficientes la semana pasada para calcular la matriz.</div>`;
  } else {
    abcMatrix
      .slice()
      .sort((a, b) => b.revenue - a.revenue)
      .forEach((row) => {
        const item = document.createElement('div');
        item.className = 'bg-white rounded-xl p-4 border border-slate-200 shadow-sm flex items-center gap-4';
        item.innerHTML = `
          <span class="w-9 h-9 rounded-full flex items-center justify-center font-black text-sm shrink-0 ${classTone[row.class] || 'bg-slate-100 text-slate-500'}">${row.class}</span>
          <div class="flex-1 min-w-0">
            <h4 class="font-bold text-slate-800 truncate">${row.product_name}</h4>
            <p class="text-xs text-slate-400">Margen: ${money(row.margin)}</p>
          </div>
          <span class="font-black text-slate-800 shrink-0">${money(row.revenue)}</span>`;
        abcWrap.appendChild(item);
      });
  }

  if (!combos.length) {
    comboWrap.innerHTML = `<div class="text-center text-slate-400 py-6">Sin combos frecuentes detectados la semana pasada.</div>`;
  } else {
    combos.forEach((combo) => {
      const names = combo.items.map((id) => products.find((p) => p.id === id)?.name || 'Producto').join(' + ');
      const item = document.createElement('div');
      item.className = 'bg-white rounded-xl p-4 border border-slate-200 shadow-sm flex items-center justify-between';
      item.innerHTML = `
        <span class="font-semibold text-slate-800">${names}</span>
        <span class="text-xs text-slate-400">confianza ${Math.round(combo.confidence * 100)}% · lift ${combo.lift.toFixed(2)}</span>`;
      comboWrap.appendChild(item);
    });
  }
}

el('btn-update-insights')?.addEventListener('click', async () => {
  const btn = el('btn-update-insights');
  const label = el('btn-insights-label');
  btn.disabled = true;
  label.textContent = 'Calculando...';
  try {
    const res = await fetch(`${ML_SERVICE_URL}/update-insights`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location_id: locationId }),
    });
    if (!res.ok) throw new Error('Error del servicio ML');
    await loadInsights();
    label.textContent = 'Actualizar insights';
  } catch (e) {
    label.textContent = 'Actualizar insights';
    alert('No se pudo conectar con el servicio de predicción (ml-service). ¿Está corriendo?');
  } finally {
    btn.disabled = false;
  }
});
