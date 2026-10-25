const DB_NAME = 'neo-world-library-db';
const DB_VERSION = 1;
let dbPromise;
let saveQueue = Promise.resolve();

export function openDatabase() {
  if (!('indexedDB' in globalThis)) return Promise.reject(new Error('IndexedDB is not available in this browser.'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('appState')) db.createObjectStore('appState');
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache', { keyPath: 'resourceId' });
    };
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => db.close(); resolve(db); };
    request.onerror = () => reject(request.error || new Error('Could not open browser database.'));
    request.onblocked = () => reject(new Error('The database is blocked by another open tab. Close other Neo World tabs and retry.'));
  });
  return dbPromise;
}

export async function dbGet(storeName, key) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Read failed.'));
  });
}

export async function dbPut(storeName, value, key) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    if (key === undefined) store.put(value); else store.put(value, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('Write failed.'));
    tx.onabort = () => reject(tx.error || new Error('Write aborted.'));
  });
}


export async function dbGetAll(storeName) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error || new Error(`Could not list ${storeName} records.`));
  });
}

export async function dbDelete(storeName, key) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('Delete failed.'));
  });
}

export async function saveAppState(state) {
  const snapshot = structuredCloneSafe(state);
  saveQueue = saveQueue.catch(() => {}).then(() => dbPut('appState', snapshot, 'current'));
  try {
    await saveQueue;
    try { localStorage.setItem('neo-world-library-last-state', JSON.stringify({ savedAt: new Date().toISOString(), resourceCount: state.resources?.length || 0 })); } catch {}
    return { mode: 'indexeddb', ok: true };
  } catch (error) {
    try {
      localStorage.setItem('neo-world-library-v2-fallback', JSON.stringify(snapshot));
      return { mode: 'localStorage', ok: true, warning: 'IndexedDB failed; using localStorage for metadata only.' };
    } catch {
      return { mode: 'unavailable', ok: false, error };
    }
  }
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
