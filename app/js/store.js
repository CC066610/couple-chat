// store.js — IndexedDB 持久层，所有数据只留在这台设备上。
// 消息体在写库前已用会话密钥加密（见 ui.js），库里只存密文。

const DB_NAME = 'couple-chat';
// v2：新增 files 存储（附件密文 Blob）。升级只建新表，不碰老数据。
const DB_VERSION = 2;
const STORES = ['identity', 'peer', 'messages', 'meta', 'files'];

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'k' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode = 'readonly') {
  const db = await openDb();
  return db.transaction(store, mode).objectStore(store);
}

export async function get(store, key) {
  const s = await tx(store);
  return new Promise((resolve, reject) => {
    const r = s.get(key);
    r.onsuccess = () => resolve(r.result ? r.result.v : null);
    r.onerror = () => reject(r.error);
  });
}

export async function put(store, key, value) {
  const s = await tx(store, 'readwrite');
  return new Promise((resolve, reject) => {
    const r = s.put({ k: key, v: value });
    r.onsuccess = () => resolve(true);
    r.onerror = () => reject(r.error);
  });
}

export async function del(store, key) {
  const s = await tx(store, 'readwrite');
  return new Promise((resolve, reject) => {
    const r = s.delete(key);
    r.onsuccess = () => resolve(true);
    r.onerror = () => reject(r.error);
  });
}

export async function all(store) {
  const s = await tx(store);
  return new Promise((resolve, reject) => {
    const r = s.getAll();
    r.onsuccess = () => resolve(r.result.map((row) => row.v));
    r.onerror = () => reject(r.error);
  });
}

export async function clearStore(store) {
  const s = await tx(store, 'readwrite');
  return new Promise((resolve, reject) => {
    const r = s.clear();
    r.onsuccess = () => resolve(true);
    r.onerror = () => reject(r.error);
  });
}

export async function wipeAll() {
  for (const name of STORES) {
    if (name === 'identity') continue; // 身份保留，解除只清关系与历史
    await clearStore(name);
  }
}
