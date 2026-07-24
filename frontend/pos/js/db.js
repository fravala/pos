// IndexedDB — caché offline-first + cola de sincronización
const DB_NAME = 'pos_offline_db';
const DB_VERSION = 1;

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('products')) {
        db.createObjectStore('products', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('inventory_catalog')) {
        db.createObjectStore('inventory_catalog', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('recipes_bom')) {
        db.createObjectStore('recipes_bom', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('sync_queue')) {
        db.createObjectStore('sync_queue', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('session')) {
        db.createObjectStore('session', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(storeName, mode) {
  const db = await openDb();
  return db.transaction(storeName, mode).objectStore(storeName);
}

export async function putAll(storeName, records) {
  const db = await openDb();
  const t = db.transaction(storeName, 'readwrite');
  const store = t.objectStore(storeName);
  records.forEach((r) => store.put(r));
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function getAll(storeName) {
  const store = await tx(storeName, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function setSessionValue(key, value) {
  const store = await tx('session', 'readwrite');
  store.put({ key, value });
}

export async function getSessionValue(key) {
  const store = await tx('session', 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => reject(req.error);
  });
}

// --- Sync queue: encola operaciones (ventas) hechas offline para reenviar al reconectar ---
export async function enqueueSync(payload) {
  const store = await tx('sync_queue', 'readwrite');
  store.add({ payload, created_at: Date.now() });
}

export async function getQueuedSync() {
  return getAll('sync_queue');
}

export async function clearQueuedSync(id) {
  const store = await tx('sync_queue', 'readwrite');
  store.delete(id);
}

export async function drainSyncQueue(sendFn) {
  const items = await getQueuedSync();
  for (const item of items) {
    try {
      await sendFn(item.payload);
      await clearQueuedSync(item.id);
    } catch (e) {
      // se detiene al primer fallo — mantiene orden FIFO de ventas
      break;
    }
  }
}
