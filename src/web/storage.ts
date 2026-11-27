// The saved databases, in IndexedDB: one record each, with a revision number so
// that two open tabs cannot silently overwrite each other. A tab works on one of
// them at a time, the one it last chose.

export type Snapshot = { dump: string; database: string; files: [string, string][] };
type Saved = { rev: number; snapshot: Snapshot };

const FIRST = "snapshot"; // the only record before there could be several
const CHOSEN = "opendoor-database:" + new URL(".", globalThis.location?.href ?? "http://localhost/").pathname;
let handle: Promise<IDBDatabase> | null = null;
let current = FIRST;
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

export type Entry = { key: string; name: string };

export const current_key = () => current;
export const new_key = () => "db:" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// The tab's own choice, then the last one made in any tab.
function chosen(): string | null {
  for (const store of ["sessionStorage", "localStorage"] as const) {
    try {
      const key = globalThis[store].getItem(CHOSEN);
      if (key) return key;
    } catch {
      // no memory of it: the first one kept is taken
    }
  }
  return null;
}

function choose(key: string): void {
  current = key;
  for (const store of ["sessionStorage", "localStorage"] as const) {
    try {
      globalThis[store].setItem(CHOSEN, key);
    } catch {
      // as above
    }
  }
}

// Work on `key` from now on; `rev` is what was read of it (0: nothing yet).
export function use_database(key: string, rev: number = 0): void {
  choose(key);
  revision = rev;
}

function request_of<T>(work: (store: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode = "readonly"): Promise<T> {
  return connected((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction("saved", mode);
    const request = work(transaction.objectStore("saved"));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("the browser's storage failed"));
  }));
}

export async function read_database(key: string): Promise<{ rev: number; snapshot: Snapshot } | null> {
  return (await request_of<Saved | undefined>((store) => store.get(key))) ?? null;
}

export function list_databases(): Promise<Entry[]> {
  return connected((database) => new Promise((resolve, reject) => {
    const found: Entry[] = [];
    const request = database.transaction("saved").objectStore("saved").openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve(found);
      found.push({ key: String(cursor.key), name: (cursor.value as Saved).snapshot.database });
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  }));
}

export async function delete_database(key: string): Promise<void> {
  await request_of((store) => store.delete(key), "readwrite");
}

// What this tab works on: its choice, or else the first one kept. A choice that
// has nothing saved under it is an untouched demo.
export async function read_saved(): Promise<Snapshot | null> {
  const key = chosen() ?? (await list_databases())[0]?.key ?? FIRST;
  const saved = await read_database(key);
  use_database(key, saved?.rev ?? 0);
  return saved?.snapshot ?? null;
}

// `replace` is for a deliberate new start (reset, open file): it wins over other tabs.
export function write_saved(snapshot: Snapshot, replace = false): Promise<void> {
  return connected((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction("saved", "readwrite");
    const objects = transaction.objectStore("saved");
    let next = 0;
    let problem: Error | null = null;
    const key = current;
    const request = objects.get(key);
    request.onsuccess = () => {
      // No record: the browser's storage was cleared, so there is nothing to overwrite.
      const stored = (request.result as Saved | undefined)?.rev;
      if (!replace && stored !== undefined && stored !== revision) {
        problem = new Error("another tab has changed the database; reload this page");
        return;
      }
      next = (stored ?? 0) + 1;
      objects.put({ rev: next, snapshot }, key);
    };
    transaction.oncomplete = () => {
      if (problem) return reject(problem);
      if (key === current) revision = next;
      resolve();
    };
    transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("the write was aborted"));
  }));
}
