/**
 * EngineClient (разд. 6.14, п. 1): единственный путь стора к ядру.
 *
 * Режим worker: ядро в модульном Web Worker. Запрос дольше 3 с обрывается
 * (у sql.js нет прерывания): воркер убивается, мир загружается из IndexedDB
 * или генерируется заново, база дела собирается и журнал воспроизводится
 * детерминированно (патчи, живые строки, DML игрока, query_log). Затем
 * run() возвращает результат с errorKind 'timeout' и объяснением.
 *
 * Режим in-process: то же ядро в том же потоке, без таймаута — для тестов
 * и браузеров без Worker. Сообщения так же проходят structured
 * clone, поэтому несериализуемое падает одинаково в обоих режимах.
 */
import type { CaseDef } from "@/types/case";
import type { StoryPatchParams } from "../world/horizon";
import { EngineHost } from "./host";
import { appendJournal, withoutPlayerWrites } from "./journal";
import type { HostRequest, WorkerInbound, WorkerOutbound } from "./protocol";
import type { ClockOutput, PatchOutput, RunOutput } from "./session";
import type {
  CaseOpened,
  CaseSaveState,
  EngineClient,
  EngineClientOptions,
  EngineProgress,
  EngineStatus,
  Evaluation,
  JournalEntry,
  PatchApplied,
  RunContext,
  WorkerLike,
  WorldInfo,
} from "./types";
import { idbWorldCache, indexedDbAvailable, layeredWorldCache, memoryWorldCache } from "./world-cache";

/** Предел запроса игрока (разд. 6.14, п. 1) */
export const QUERY_TIMEOUT_MS = 3000;
/** Предел на подъём нового воркера и воспроизведение журнала */
const RECOVERY_TIMEOUT_MS = 60_000;

type FailureReason = "timeout" | "crash" | "remote";

class TransportError extends Error {
  constructor(
    message: string,
    readonly reason: FailureReason
  ) {
    super(message);
  }
}

interface CallOptions {
  timeoutMs?: number;
  onProgress?: (progress: EngineProgress) => void;
}

interface Transport {
  /** Можно ли оборвать операцию (воркер убивается); у внутрипроцессного — нет */
  readonly killable: boolean;
  call<T>(request: HostRequest, options?: CallOptions): Promise<T>;
  terminate(): void;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

// --- Транспорт: Web Worker ---

function workerTransport(worker: WorkerLike): Transport {
  let nextId = 1;
  let dead = false;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; onProgress?: CallOptions["onProgress"]; timer?: ReturnType<typeof setTimeout> }
  >();

  const failAll = (error: TransportError) => {
    for (const p of pending.values()) {
      if (p.timer !== undefined) clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  };

  worker.onmessage = (event) => {
    const message = event.data as WorkerOutbound;
    const p = pending.get(message.id);
    if (!p) return;
    if (message.type === "progress") {
      p.onProgress?.(message.progress);
      return;
    }
    pending.delete(message.id);
    if (p.timer !== undefined) clearTimeout(p.timer);
    if (message.ok) p.resolve(message.value);
    else p.reject(new TransportError(message.error, message.fatal ? "crash" : "remote"));
  };
  worker.onerror = (event) => {
    dead = true;
    failAll(new TransportError(`Ядро остановилось: ${errorText(event)}`, "crash"));
  };

  return {
    killable: true,
    call<T>(request: HostRequest, options: CallOptions = {}): Promise<T> {
      if (dead) return Promise.reject(new TransportError("Ядро остановлено.", "crash"));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timer =
          options.timeoutMs !== undefined
            ? setTimeout(() => {
                pending.delete(id);
                reject(new TransportError("Операция ядра не уложилась во время.", "timeout"));
              }, options.timeoutMs)
            : undefined;
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, onProgress: options.onProgress, timer });
        try {
          worker.postMessage({ id, request } satisfies WorkerInbound);
        } catch (e) {
          // DataCloneError: в запросе несериализуемое (функция в правиле custom)
          pending.delete(id);
          if (timer !== undefined) clearTimeout(timer);
          reject(new TransportError(errorText(e), "remote"));
        }
      });
    },
    terminate() {
      dead = true;
      failAll(new TransportError("Ядро остановлено.", "crash"));
      worker.terminate();
    },
  };
}

// --- Транспорт: тот же поток ---

const clone = <T>(value: T): T => (typeof structuredClone === "function" ? structuredClone(value) : value);

function directTransport(host: EngineHost): Transport {
  return {
    killable: false,
    async call<T>(request: HostRequest, options: CallOptions = {}): Promise<T> {
      try {
        return clone((await host.handle(clone(request), options.onProgress)) as T);
      } catch (e) {
        throw new TransportError(errorText(e), "remote");
      }
    },
    terminate() {
      host.close();
    },
  };
}

// --- Клиент ---

/** Сцены ядру не нужны: в воркер уходит дело без script.json */
function forEngine(caseDef: CaseDef): CaseDef {
  return { ...caseDef, scenes: [] };
}

function normalized(journal: readonly JournalEntry[] = []): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (const entry of journal) appendJournal(out, entry);
  return out;
}

class EngineClientImpl implements EngineClient {
  readonly mode: "worker" | "in-process";
  private readonly spawn: () => Transport;
  private readonly options: EngineClientOptions;
  private readonly timeoutMs: number;
  private transport: Transport | null = null;
  private currentStatus: EngineStatus = "idle";
  private queue: Promise<unknown> = Promise.resolve();
  private initPromise: Promise<WorldInfo> | null = null;
  /** Дело без журнала: из него собирается база при восстановлении и откате */
  private opened: { caseDef: CaseDef; state: CaseSaveState } | null = null;
  private journal: JournalEntry[] = [];

  constructor(mode: "worker" | "in-process", spawn: () => Transport, options: EngineClientOptions) {
    this.mode = mode;
    this.spawn = spawn;
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? QUERY_TIMEOUT_MS;
  }

  get status(): EngineStatus {
    return this.currentStatus;
  }

  private setStatus(status: EngineStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.options.onStatus?.(status);
  }

  /** Операции строго по очереди: следующая ждёт предыдущую (и восстановление) */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private requireTransport(): Transport {
    if (this.currentStatus === "disposed") throw new Error("Ядро остановлено (dispose).");
    if (!this.transport) throw new Error("Ядро не запущено: сначала init().");
    return this.transport;
  }

  private requireCase(): { caseDef: CaseDef; state: CaseSaveState } {
    if (!this.opened) throw new Error("Дело не открыто: сначала openCase().");
    return this.opened;
  }

  private absorb(entries: readonly JournalEntry[]): void {
    for (const entry of entries) appendJournal(this.journal, entry);
  }

  private initRequest(): HostRequest {
    return {
      op: "init",
      ...(this.options.seed !== undefined ? { seed: this.options.seed } : {}),
      secrets: this.options.secrets ?? [],
      ...(this.options.wasmUrl ? { wasmUrl: this.options.wasmUrl } : {}),
    };
  }

  init(onProgress?: (progress: EngineProgress) => void): Promise<WorldInfo> {
    if (!this.initPromise) {
      this.initPromise = this.enqueue(async () => {
        this.setStatus("loading");
        try {
          this.transport?.terminate();
          this.transport = this.spawn();
          const info = await this.transport.call<WorldInfo>(this.initRequest(), { onProgress });
          this.setStatus("ready");
          return info;
        } catch (e) {
          this.setStatus("failed");
          this.initPromise = null;
          throw e instanceof TransportError ? new Error(e.message) : e;
        }
      });
    }
    return this.initPromise;
  }

  /**
   * Новый транспорт → мир из кеша → база дела → журнал. Вызывается после
   * таймаута или падения ядра; в очереди операций уже стоит текущая.
   */
  private async recover(): Promise<{ ms: number; replayed: number }> {
    if (this.currentStatus === "disposed") throw new Error("Ядро остановлено (dispose).");
    const t0 = now();
    this.setStatus("recovering");
    this.transport?.terminate();
    try {
      this.transport = this.spawn();
      await this.transport.call<WorldInfo>(this.initRequest(), { timeoutMs: RECOVERY_TIMEOUT_MS });
      let replayed = 0;
      if (this.opened) {
        const opened = await this.transport.call<CaseOpened>(
          { op: "open", caseDef: this.opened.caseDef, state: { ...this.opened.state, journal: this.journal } },
          { timeoutMs: RECOVERY_TIMEOUT_MS }
        );
        replayed = opened.replayed;
      }
      this.setStatus("ready");
      return { ms: Math.round(now() - t0), replayed };
    } catch (e) {
      this.setStatus("failed");
      throw new Error(`Ядро не восстановилось: ${errorText(e)}`);
    }
  }

  /** Операция без таймаута; если ядро упало — восстановление и один повтор */
  private async call<T>(request: HostRequest): Promise<T> {
    try {
      return await this.requireTransport().call<T>(request);
    } catch (e) {
      if (!(e instanceof TransportError)) throw e;
      if (e.reason === "remote" || !this.requireTransport().killable) throw new Error(e.message);
      await this.recover();
      try {
        return await this.requireTransport().call<T>(request);
      } catch (again) {
        throw again instanceof TransportError ? new Error(again.message) : again;
      }
    }
  }

  async openCase(caseDef: CaseDef, saveState: CaseSaveState = {}): Promise<CaseOpened> {
    await this.init();
    return this.enqueue(async () => {
      const def = forEngine(caseDef);
      const journal = normalized(saveState.journal);
      const state: CaseSaveState = { ...saveState };
      delete state.journal;
      const opened = await this.call<CaseOpened>({ op: "open", caseDef: def, state: { ...state, journal } });
      this.opened = { caseDef: def, state };
      this.journal = journal;
      return opened;
    });
  }

  run(sql: string, context: RunContext = {}): Promise<Evaluation> {
    return this.enqueue(async () => {
      this.requireCase();
      const transport = this.requireTransport();
      const started = now();
      try {
        const out = await transport.call<RunOutput>(
          { op: "run", sql, context },
          transport.killable ? { timeoutMs: this.timeoutMs } : {}
        );
        this.absorb(out.journal);
        return out.evaluation;
      } catch (e) {
        if (!(e instanceof TransportError)) throw e;
        if (e.reason === "remote" || !transport.killable) throw new Error(e.message);
        const reason = e.reason;
        const elapsedMs = Math.round(now() - started);
        const recovery = await this.recover();
        const out = await this.requireTransport().call<RunOutput>(
          { op: "stopped", sql, context, reason, elapsedMs, limitMs: this.timeoutMs },
          { timeoutMs: RECOVERY_TIMEOUT_MS }
        );
        this.absorb(out.journal);
        return { ...out.evaluation, recovery: { reason, ms: recovery.ms, replayed: recovery.replayed } };
      }
    });
  }

  applyPatch(id: string, params?: StoryPatchParams): Promise<PatchApplied> {
    return this.enqueue(async () => {
      this.requireCase();
      const out = await this.call<PatchOutput>({ op: "patch", id, ...(params ? { params } : {}) });
      this.absorb(out.journal);
      return out.applied;
    });
  }

  setClock(clock: string): Promise<string> {
    return this.enqueue(async () => {
      this.requireCase();
      const out = await this.call<ClockOutput>({ op: "clock", clock });
      this.absorb(out.journal);
      return out.clock;
    });
  }

  resetCase(): Promise<CaseOpened> {
    return this.enqueue(async () => {
      const { caseDef, state } = this.requireCase();
      const journal = withoutPlayerWrites(this.journal);
      const opened = await this.call<CaseOpened>({ op: "open", caseDef, state: { ...state, journal } });
      this.journal = journal;
      return opened;
    });
  }

  getJournal(): readonly JournalEntry[] {
    return [...this.journal];
  }

  checksum(): Promise<string> {
    return this.enqueue(async () => {
      this.requireCase();
      return this.call<string>({ op: "checksum" });
    });
  }

  dispose(): void {
    this.transport?.terminate();
    this.transport = null;
    this.opened = null;
    this.journal = [];
    this.setStatus("disposed");
  }
}

// --- Фабрика ---

function defaultWorkerFactory(): WorkerLike {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "zerosql-engine" }) as unknown as WorkerLike;
}

function inProcessCache() {
  return indexedDbAvailable() ? layeredWorldCache(memoryWorldCache, idbWorldCache()) : memoryWorldCache;
}

/**
 * Клиент ядра для стора. При наличии Worker запросы прерываемы даже без
 * IndexedDB; после сбоя без кеша мир придётся сгенерировать заново.
 */
export function createEngineClient(options: EngineClientOptions = {}): EngineClient {
  const hasWorker = Boolean(options.workerFactory) || typeof Worker !== "undefined";
  let useWorker: boolean;
  switch (options.mode ?? "auto") {
    case "in-process":
      useWorker = false;
      break;
    case "worker":
      useWorker = hasWorker;
      break;
    default:
      useWorker = hasWorker;
  }
  if (useWorker) {
    const factory = options.workerFactory ?? defaultWorkerFactory;
    return new EngineClientImpl("worker", () => workerTransport(factory()), options);
  }
  return new EngineClientImpl("in-process", () => directTransport(new EngineHost({ cache: inProcessCache() })), options);
}
