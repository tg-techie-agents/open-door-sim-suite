// The saved database, in IndexedDB. One record per deployment folder, with a
// revision number so that two open tabs cannot silently overwrite each other.

export type Snapshot = { dump: string; database: string; files: [string, string][] };
type Saved = { rev: number; snapshot: Snapshot };

const KEY = "snapshot";
let handle: Promise<IDBDatabase> | null = null;
let revision = 0;

function open(): Promise<IDBDatabase> {
  if (handle) return handle;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("opendoor-practice:" + new URL(".", location.href).pathname, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("saved");
    request.onsuccess = () => {
      // The browser may close a connection at any time; the next use opens another.
      request.result.onclose = request.result.onversionchange = () => forget(opening);
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
  return (handle = opening);
}

function forget(connection: Promise<IDBDatabase>): void {
  if (handle === connection) handle = null;
  connection.then((database) => database.close(), () => {});
}

// A connection that was closed without saying so fails when used: try a new one, once.
async function connected<T>(work: (database: IDBDatabase) => Promise<T>): Promise<T> {
  const connection = open();
  try {
    return await work(await connection);
  } catch {
    forget(connection);
    return work(await open());
  }
}

export function read_saved(): Promise<Snapshot | null> {
  return connected((database) => new Promise((resolve, reject) => {
    const request = database.transaction("saved").objectStore("saved").get(KEY);
    request.onsuccess = () => {
      const saved = request.result as Saved | undefined;
      revision = saved?.rev ?? 0;
      resolve(saved?.snapshot ?? null);
    };
    request.onerror = () => reject(request.error);
  }));
}

// `replace` is for a deliberate new start (reset, open file): it wins over other tabs.
export function write_saved(snapshot: Snapshot, replace = false): Promise<void> {
  return connected((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction("saved", "readwrite");
    const objects = transaction.objectStore("saved");
    let next = 0;
    let problem: Error | null = null;
    const request = objects.get(KEY);
    request.onsuccess = () => {
      // No record: the browser's storage was cleared, so there is nothing to overwrite.
      const stored = (request.result as Saved | undefined)?.rev;
      if (!replace && stored !== undefined && stored !== revision) {
        problem = new Error("another tab has changed the database; reload this page");
        return;
      }
      next = (stored ?? 0) + 1;
      objects.put({ rev: next, snapshot }, KEY);
    };
    transaction.oncomplete = () => {
      if (problem) return reject(problem);
      revision = next;
      resolve();
    };
    transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("the write was aborted"));
  }));
}
