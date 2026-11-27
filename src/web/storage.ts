// The saved database, in IndexedDB. One record per deployment folder, with a
// revision number so that two open tabs cannot silently overwrite each other.

export type Snapshot = { dump: string; database: string; files: [string, string][] };
type Saved = { rev: number; snapshot: Snapshot };

const KEY = "snapshot";
let handle: Promise<IDBDatabase> | null = null;
let revision = 0;

function open(): Promise<IDBDatabase> {
  handle ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("opendoor-practice:" + new URL(".", location.href).pathname, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("saved");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return handle;
}

export async function read_saved(): Promise<Snapshot | null> {
  const database = await open();
  return new Promise((resolve, reject) => {
    const request = database.transaction("saved").objectStore("saved").get(KEY);
    request.onsuccess = () => {
      const saved = request.result as Saved | undefined;
      revision = saved?.rev ?? 0;
      resolve(saved?.snapshot ?? null);
    };
    request.onerror = () => reject(request.error);
  });
}

// `replace` is for a deliberate new start (reset, open file): it wins over other tabs.
export async function write_saved(snapshot: Snapshot, replace = false): Promise<void> {
  const database = await open();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("saved", "readwrite");
    const objects = transaction.objectStore("saved");
    let next = 0;
    let problem: Error | null = null;
    const request = objects.get(KEY);
    request.onsuccess = () => {
      const stored = (request.result as Saved | undefined)?.rev ?? 0;
      if (!replace && stored !== revision) {
        problem = new Error("another tab has changed the database; reload this page");
        return;
      }
      next = stored + 1;
      objects.put({ rev: next, snapshot }, KEY);
    };
    transaction.oncomplete = () => {
      if (problem) return reject(problem);
      revision = next;
      resolve();
    };
    transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("the write was aborted"));
  });
}
