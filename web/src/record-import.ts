export interface RecordImportError {
  step: number;
  token: string;
  decodedMove: string | null;
  kind: string;
  candidates: string[];
  messageZh: string;
}

export interface RecordImportResult {
  format: "iccs" | "chinese" | "pgn" | "dhtmlxq" | null;
  startFen: string | null;
  moves: string[];
  warnings: string[];
  metadata: Record<string, string>;
  isStandardStart: boolean | null;
  errors: RecordImportError[];
}

export class RecordImportClient {
  private nextId = 1;
  private readonly pending = new Map<number, (result: RecordImportResult) => void>();

  constructor(private readonly worker: Worker) {
    worker.addEventListener("message", (event: MessageEvent<{ id: number; result: RecordImportResult }>) => {
      const resolve = this.pending.get(event.data.id);
      if (!resolve) return;
      this.pending.delete(event.data.id);
      resolve(event.data.result);
    });
  }

  parse(text: string): Promise<RecordImportResult> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage({ id, text });
    });
  }
}
