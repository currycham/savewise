// 本地存储：所有流水和设置只存在这台设备的浏览器里（IndexedDB），不上传服务器。
// 一个简单的键值库；IndexedDB 不可用（隐私模式等）时退回内存，刷新就没了。
const DB = "savewise", STORE = "kv";
let dbp = null;
const mem = new Map();

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}

export async function get(key, fallback = null) {
  const db = await open();
  if (!db) return mem.has(key) ? mem.get(key) : fallback;
  const v = await tx(db, "readonly", (s) => s.get(key));
  return v === undefined ? fallback : v;
}

export async function set(key, value) {
  const db = await open();
  if (!db) { mem.set(key, value); return; }
  await tx(db, "readwrite", (s) => s.put(value, key));
}

export async function del(key) {
  const db = await open();
  if (!db) { mem.delete(key); return; }
  await tx(db, "readwrite", (s) => s.delete(key));
}

export async function keys() {
  const db = await open();
  if (!db) return [...mem.keys()];
  return tx(db, "readonly", (s) => s.getAllKeys());
}

export async function clearAll() {
  const db = await open();
  if (!db) { mem.clear(); return; }
  await tx(db, "readwrite", (s) => s.clear());
}

export const persistent = async () => !!(await open());
