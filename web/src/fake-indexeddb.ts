/**
 * A small in-memory stand-in for the parts of IndexedDB the review cache uses (open, object stores,
 * get/put/delete/getAll/count inside a transaction). Tests only. Requests complete on a later tick,
 * and a transaction completes once no request is outstanding, as in a browser.
 */
export interface FakeIndexedDb {
  factory: IDBFactory;
  /** Raw rows by store name, to inspect what was really written. */
  stores: Map<string, Map<string, unknown>>;
  /** While true, `open` fails with an error event (private mode, blocked storage). */
  failOpen: boolean;
  /** While true, every request in a transaction fails (quota exceeded). */
  failRequests: boolean;
}

interface FakeRequest<T> {
  result: T | undefined;
  error: Error | null;
  onsuccess: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export function createFakeIndexedDb(): FakeIndexedDb {
  const state: FakeIndexedDb = {
    factory: undefined as unknown as IDBFactory,
    stores: new Map(),
    failOpen: false,
    failRequests: false,
  };
  const keyPaths = new Map<string, string>();

  const database = {
    objectStoreNames: { contains: (name: string) => state.stores.has(name) },
    createObjectStore: (name: string, options: { keyPath: string }) => {
      state.stores.set(name, new Map());
      keyPaths.set(name, options.keyPath);
      return {};
    },
    onversionchange: null as (() => void) | null,
    close: () => {},
    transaction: (names: string | string[]) => {
      const allowed = new Set(Array.isArray(names) ? names : [names]);
      let outstanding = 0;
      let done = false;
      let failed = false;
      const tx: Record<string, unknown> = { error: null, oncomplete: null, onabort: null, onerror: null };
      const settle = () => {
        if (done || outstanding > 0) return;
        setTimeout(() => {
          if (done || outstanding > 0) return;
          done = true;
          if (failed) (tx.onabort as (() => void) | null)?.();
          else (tx.oncomplete as (() => void) | null)?.();
        }, 0);
      };
      const request = <T>(run: () => T): FakeRequest<T> => {
        const req: FakeRequest<T> = { result: undefined, error: null, onsuccess: null, onerror: null };
        outstanding += 1;
        setTimeout(() => {
          try {
            if (state.failRequests) throw new Error("QuotaExceededError");
            req.result = run();
            req.onsuccess?.({ target: req });
          } catch (error) {
            failed = true;
            req.error = error as Error;
            tx.error = error;
            req.onerror?.({ target: req });
          } finally {
            outstanding -= 1;
            settle();
          }
        }, 0);
        return req;
      };
      tx.objectStore = (name: string) => {
        if (!allowed.has(name)) throw new Error("NotFoundError");
        const rows = state.stores.get(name)!;
        const keyPath = keyPaths.get(name)!;
        return {
          get: (key: string) => request(() => structuredClone(rows.get(key))),
          put: (value: Record<string, string>) => request(() => {
            rows.set(value[keyPath]!, structuredClone(value));
            return value[keyPath];
          }),
          delete: (key: string) => request(() => { rows.delete(key); }),
          getAll: () => request(() => [...rows.values()].map((row) => structuredClone(row))),
          count: () => request(() => rows.size),
        };
      };
      outstanding += 1;
      setTimeout(() => { outstanding -= 1; settle(); }, 0);
      return tx;
    },
  };

  state.factory = {
    open: () => {
      const req: Record<string, unknown> = { result: database, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      setTimeout(() => {
        if (state.failOpen) {
          req.error = new Error("SecurityError");
          (req.onerror as (() => void) | null)?.();
          return;
        }
        const fresh = state.stores.size === 0;
        if (fresh) (req.onupgradeneeded as (() => void) | null)?.();
        (req.onsuccess as (() => void) | null)?.();
      }, 0);
      return req;
    },
  } as unknown as IDBFactory;
  return state;
}
