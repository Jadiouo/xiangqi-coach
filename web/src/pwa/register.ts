interface WorkerLike {
  state?: string;
  postMessage(message: unknown): void;
  addEventListener(type: "statechange", listener: () => void): void;
}

interface RegistrationLike {
  waiting?: WorkerLike | null;
  installing?: WorkerLike | null;
  update?(): Promise<unknown>;
  addEventListener?(type: "updatefound", listener: () => void): void;
}

interface ServiceWorkerContainerLike {
  controller?: unknown;
  register(url: string, options: { scope: string }): Promise<unknown>;
  addEventListener?(type: "controllerchange", listener: () => void): void;
}

interface ServiceWorkerHost {
  serviceWorker?: ServiceWorkerContainerLike;
}

interface VisibilityHost {
  visibilityState?: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface RegisterOptions {
  navigator: ServiceWorkerHost;
  base: string;
  production: boolean;
  /**
   * Called (possibly more than once) when a new version is waiting. `apply` looks up the waiting worker
   * at call time: it returns true after asking it to take over (this tab then reloads once), or false
   * when nothing is waiting any more (it then asks the browser to check for an update).
   */
  onUpdateReady?: (apply: () => boolean) => void;
  /** Called when another tab applied an update and this tab (which did not ask) now has a new controller. */
  onUpdatedElsewhere?: () => void;
  reload?: () => void;
  document?: VisibilityHost;
  now?: () => number;
  /** Minimum gap between registration.update() calls triggered by the tab becoming visible. */
  updateCheckIntervalMs?: number;
}

export const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Registers the production service worker. Never throws; returns whether registration succeeded. */
export async function registerServiceWorker(options: RegisterOptions): Promise<boolean> {
  const container = options.navigator.serviceWorker;
  if (!options.production || !container) return false;
  let registration: unknown;
  try {
    registration = await container.register(`${options.base}sw.js`, { scope: options.base });
  } catch {
    return false;
  }
  try {
    watchForUpdates(container, registration as RegistrationLike | undefined, options);
  } catch {
    // The update prompt is a convenience; never let it break registration.
  }
  return true;
}

function watchForUpdates(container: ServiceWorkerContainerLike, registration: RegistrationLike | undefined, options: RegisterOptions): void {
  const notify = options.onUpdateReady;
  if (!registration || !notify) return;
  let applying = false;
  let reloaded = false;
  const hadController = Boolean(container.controller);

  const apply = (): boolean => {
    const worker = registration.waiting;
    if (!worker) {
      void registration.update?.().catch(() => {});
      return false;
    }
    applying = true;
    worker.postMessage({ type: "skip-waiting" });
    return true;
  };

  // The first install also fires controllerchange (clients.claim); ignore it. A change we asked for reloads
  // once; a change another tab asked for only shows a notice, so this tab is never reloaded under the user.
  container.addEventListener?.("controllerchange", () => {
    if (applying) {
      if (reloaded) return;
      reloaded = true;
      (options.reload ?? (() => globalThis.location?.reload()))();
    } else if (hadController) {
      options.onUpdatedElsewhere?.();
    }
  });

  if (registration.waiting && container.controller) notify(apply);

  registration.addEventListener?.("updatefound", () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed" && container.controller) notify(apply);
    });
  });

  const doc = options.document;
  if (doc && registration.update) {
    const now = options.now ?? (() => Date.now());
    const interval = options.updateCheckIntervalMs ?? DEFAULT_UPDATE_CHECK_INTERVAL_MS;
    let lastCheck = now();
    doc.addEventListener("visibilitychange", () => {
      if (doc.visibilityState === "hidden") return;
      const t = now();
      if (t - lastCheck < interval) return;
      lastCheck = t;
      void registration.update?.().catch(() => {});
    });
  }
}
