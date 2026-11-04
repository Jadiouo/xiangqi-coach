import type { RecordImportResult } from "./record-import";

interface ImportModule {
  default: () => Promise<unknown>;
  import_record(text: string): string;
}

interface ImportRequest {
  id: number;
  text: string;
}

interface WorkerScope extends EventTarget {
  postMessage(message: unknown): void;
  readonly location: Location;
}

const scope = self as unknown as WorkerScope;
let modulePromise: Promise<ImportModule> | null = null;

async function importModule(): Promise<ImportModule> {
  if (!modulePromise) {
    const wasmUrl = new URL(`${import.meta.env.BASE_URL}wasm/xq_wasm.js`, scope.location.origin).href;
    modulePromise = import(/* @vite-ignore */ wasmUrl).then(async (loaded) => {
      const module = loaded as ImportModule;
      await module.default();
      return module;
    });
  }
  return modulePromise;
}

scope.addEventListener("message", ((event: MessageEvent<ImportRequest>) => {
  void importModule().then((module) => {
    const result = JSON.parse(module.import_record(event.data.text)) as RecordImportResult;
    scope.postMessage({ id: event.data.id, result });
  }).catch(() => {
    const result: RecordImportResult = {
      format: null,
      startFen: null,
      moves: [],
      warnings: [],
      metadata: {},
      isStandardStart: null,
      errors: [{ step: 0, token: "", decodedMove: null, kind: "worker_failed", candidates: [], messageZh: "棋譜格式辨識失敗，請重新載入後再試。" }],
    };
    scope.postMessage({ id: event.data.id, result });
  });
}) as EventListener);
