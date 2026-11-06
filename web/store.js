const DATABASE = 'typeandsee-browser-v1';
let databasePromise;

function open() {
  if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('images', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { databasePromise = null; reject(request.error); };
    request.onblocked = () => reject(new Error('Close other TypeAndSee tabs and retry.'));
  });
  return databasePromise;
}

export async function readAll() {
  const database = await open();
  return new Promise((resolve, reject) => {
    const request = database.transaction('images', 'readonly').objectStore('images').getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function write(records, { replace = false } = {}) {
  const database = await open();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('images', 'readwrite');
    const store = transaction.objectStore('images');
    if (replace) store.clear();
    for (const record of records) store.put(record);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Library save was interrupted.'));
  });
}
