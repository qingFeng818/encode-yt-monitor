// db.js
const DB_NAME = 'stability-monitor';
const DB_VERSION = 1;
const STORE = 'outbox';

let dbPromise = null;

export function getDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    // 只在版本号变化或首次创建时触发
    req.onupgradeneeded = (event) => {
      const db = req.result;

      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, {
          keyPath: 'id',
          autoIncrement: true,
        });
        // 按创建时间建索引，方便"取最老的一批"
        store.createIndex('by_createdAt', 'createdAt');
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return dbPromise;
}

// 在事务里执行 fn，等事务 complete 后再 resolve
export async function withStore(mode, fn) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);

    let result;
    try {
      // fn 返回一个 IDBRequest 或 undefined
      result = fn(store);
    } catch (err) {
      tx.abort();
      reject(err);
      return;
    }

    tx.oncomplete = () => {
      // 如果 fn 返回的是 request，把它的 result 传出去
      resolve(result && 'result' in result ? result.result : undefined);
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

export async function enqueue(type, payload) {
  const record = {
    type,
    payload,
    createdAt: Date.now(),
    retryCount: 0,
    status: 'pending',
  };
  const id = await withStore('readwrite', (store) => store.add(record));
  return id; // 自增主键
}

export async function takeBatch(limit = 20) {
  return new Promise(async (resolve, reject) => {
    const db = await getDB();
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const index = store.index('by_createdAt');

    const items = [];
    // 用游标按时间顺序取，最多取 limit 条
    const req = index.openCursor();

    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || items.length >= limit) return;
      items.push({ id: cursor.primaryKey, ...cursor.value });
      cursor.continue();
    };

    tx.oncomplete = () => resolve(items);
    tx.onerror = () => reject(tx.error);
  });
}
export async function remove(ids) {
  return withStore('readwrite', (store) => {
    ids.forEach((id) => store.delete(id));
  });
}

export async function bumpRetry(id) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);

    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const record = getReq.result;
      if (!record) return;
      record.retryCount += 1;
      store.put(record);
    };

    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function countPending() {
  return withStore('readonly', (store) => store.count());
}
