/**
 * Стор v2 «Полыньи» — единственный владелец состояния игры и единственный
 * потребитель ядра (@/engine). Фабрика createGameStore() даёт ванильный
 * zustand-стор: в браузере — синглтон из ./index.ts, в тестах — свой
 * экземпляр с in-process ядром и памятью вместо localStorage.
 *
 * Поток дела: календарь → openCase → вступительная сцена → стол; каждый
 * запрос идёт через EngineClient.run, затем стор обновляет задачи, улики,
 * реестр увиденного, тайники, часы и живые события, реплики линтера;
 * протокол / обвинение / допрос → финальная сцена → разбор → следующее дело.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  activeObjective,
  applyClockTo,
  availableOptions,
  caseShort,
  checkAccusation,
  checkAchievements,
  checkProtocol,
  CRON_PATCH,
  createEngineClient,
  cronFiresAfterCase,
  cronLiveParams,
  firedCronJobs,
  dueEvents,
  getScene,
  isCaseObjectivesDone,
  objectiveApplies,
  optionalObjectives,
  presentEvidence,
  presentMatches,
  pressPoint,
  protocolFailureLine,
  rankFor,
  reopenInterrogation as engineReopen,
  scoreCase,
  startInterrogation,
  STORY_PATCHES,
  type AccusationCheck,
  type AchievementDef,
  type CaseDef,
  type CaseStats,
  type CompletedObjective,
  type EngineClient,
  type EngineClientOptions,
  type Evaluation,
  type HintDef,
  type OfferedEvidence,
  type PinnedCard,
  type PlayerQueryEntry,
  type RunContext,
  type Scene,
  type SecretDef,
  type StoryPatchParams,
} from "@/engine";
import { achievements as seasonAchievements, cases as seasonCases, secrets as seasonSecrets } from "@/data";
import { computeEnding } from "./endings";
import { SAVE_KEY, SAVE_VERSION, browserStorage, migrateSave, sanitizeSave } from "./persist";
import {
  HINT_TIERS,
  MASTERY,
  PIN_ALL_LIMIT,
  WEATHER_LABELS,
  applyFlag,
  bumpMastery,
  defaultPersisted,
  deletesEvidence,
  flagRaised,
  futureConcepts,
  isIrinaNote,
  tripFlags,
  flagsBefore,
  hintTierAllowed,
  hintTierFree,
  makeCard,
  predictionsEnabled,
  pushUniq,
  sameFlags,
  shiftFlag,
  uniq,
  weatherFor,
} from "./rules";
import type {
  Bark,
  BarkKind,
  CaseSession,
  Debrief,
  EndingResult,
  Flags,
  HintReveal,
  PersistedGame,
  Profile,
  Settings,
  SolvedCase,
  StageSlot,
  Transient,
} from "./types";

// --- Публичный интерфейс ---

export interface OfferInput {
  /** id улик (EvidenceDef.id) */
  evidenceIds?: readonly string[];
  /** id приколотых карточек (PinnedCard.id) */
  cardIds?: readonly string[];
}

export interface GameActions {
  // загрузка, профиль, настройки
  /** Поднимает сохранение и ядро (мир: кеш или генерация), восстанавливает начатое дело */
  boot(): Promise<void>;
  confirmAge(): void;
  markColdOpenSeen(): void;
  setProfile(patch: Partial<Profile>): void;
  updateSettings(patch: Partial<Settings>): void;
  /** Новая игра: сезон и дело сбрасываются, настройки остаются */
  resetSeason(): void;

  // дело
  /** Открыть дело из календаря (новое или переигровка). false — закрыто или нет контента */
  openCase(caseId: string): Promise<boolean>;
  /** «Откатить базу дела к началу»: записи игрока исчезают, прогресс остаётся */
  restartCase(): Promise<void>;
  /** Бросить дело (без разбора) и вернуться в календарь */
  abandonCase(): void;
  /** Закрыть разбор и вернуться в календарь */
  finishDebrief(): void;

  // сцены
  playScene(sceneId: string): Promise<void>;
  /** Следующая реплика (или конец сцены) */
  advance(): Promise<void>;
  /** Промотать сцену до выбора / предъявления / конца */
  skipScene(): Promise<void>;
  choose(choiceId: string): Promise<void>;
  /** Предъявление в сцене (Scene.present) */
  presentInScene(offer: OfferInput): Promise<boolean>;

  // стол
  setDraft(sql: string): void;
  runQuery(sql?: string): Promise<Evaluation | null>;
  /** Следующий уровень подсказки по задаче (по умолчанию — активной) */
  revealHint(objectiveId?: string): HintReveal | null;
  /** Предложить подсказку (простой 2 минуты — таймер у UI) */
  offerHint(): void;
  dismissHintOffer(): void;
  answerPrediction(objectiveId: string, answer: number): boolean;
  /** «Приобщить» строку последнего результата */
  pinRow(rowIndex: number): PinnedCard | null;
  /** «Приобщить всё» — результат не больше 20 строк */
  pinAll(): number;
  unpin(cardId: string): void;
  setCardNode(cardId: string, node: string | undefined): void;
  dismissBark(id: number): void;
  dismissToast(id: number): void;

  // протокол, обвинение, допрос
  setSlot(blankId: string, value: string): boolean;
  submitProtocol(): Promise<void>;
  accuse(accusationId: string, accused: string, cardIds: readonly string[]): Promise<AccusationCheck | null>;
  pressStatement(line: string): Promise<void>;
  presentToSuspect(line: string, offer: OfferInput): Promise<void>;
  reopenInterrogation(sceneId: string): boolean;

  // сюжет и прогрессия
  /** Флаг из экрана (финал: адресат, K, отправка пакета) */
  setFlag(name: string, value: Flags[string]): Promise<void>;
  recordEvent(id: string): void;
  bumpCounter(name: string, by?: number): void;
}

export type GameState = PersistedGame & Transient & GameActions;
export type GameStore = StoreApi<GameState> & {
  persist: {
    rehydrate: () => Promise<void> | void;
    clearStorage: () => void;
    hasHydrated: () => boolean;
  };
};

export interface GameStoreOptions {
  /** Контент сезона (по умолчанию src/data) */
  cases?: readonly CaseDef[];
  achievements?: readonly AchievementDef[];
  secrets?: readonly SecretDef[];
  /** Ядро; по умолчанию createEngineClient (worker, если есть Worker и IndexedDB) */
  engine?: () => EngineClient;
  engineOptions?: EngineClientOptions;
  storage?: () => Storage;
  /** Не поднимать сохранение при создании (браузер: boot() поднимает его сам — без рассинхрона SSR) */
  skipHydration?: boolean;
  /** Реальное время (тесты): событие solved_after_midnight */
  now?: () => Date;
}

const MIRA = "mira";
const MAX_BARKS = 12;
const ROLLBACK_LINE = "Архив обновился. Твою открытую транзакцию я откатила — повтори, если нужно.";
const BUDGET_LINE = "Лимит запросов по делу исчерпан. Дальше — только выводы.";

const initialTransient = (): Transient => ({
  loading: { status: "idle", progress: null, fromCache: null, error: null },
  busy: false,
  schema: [],
  foreignKeys: [],
  playerViews: [],
  last: null,
  barks: [],
  toasts: [],
});

const effectiveFlags = (s: CaseSession): Flags => ({ ...s.baseFlags, ...s.flags });

/** Флаг выбора поверх флагов дела: в session.flags попадает только то, что изменилось */
function withFlag(s: CaseSession, spec: string): CaseSession {
  const before = effectiveFlags(s);
  const after = applyFlag(before, spec);
  const changed = Object.fromEntries(Object.entries(after).filter(([k, v]) => before[k] !== v || !(k in before)));
  return { ...s, flags: { ...s.flags, ...changed } };
}

/**
 * Параметры сюжетного патча: флаги ветвлений (кто импортирует диск, чьи правки
 * откатаны) и — если патчу нужны — запросы игрока прошлых дел (c10.frame).
 */
function patchParams(s: CaseSession, d: CaseDef, id: string): StoryPatchParams {
  const queries = STORY_PATCHES[id]?.needsQueries
    ? s.priorLog.filter((e) => !e.denied).map((e) => ({ loggedAt: e.loggedAt, sql: e.sql }))
    : undefined;
  // Живое задание zero (Д5): номер задания и ветка текста по увиденному
  const cron = id === CRON_PATCH ? cronLiveParams(d.order, s.seen) : null;
  return { flags: effectiveFlags(s), ...(queries ? { queries } : {}), ...(cron ?? {}) };
}

/** Сдвиг числового флага (доверие) поверх флагов ранних дел */
const shiftSessionFlag = (s: CaseSession, name: string, delta: number): CaseSession => ({
  ...s,
  flags: { ...s.flags, [name]: shiftFlag(effectiveFlags(s), name, delta)[name] },
});

function newSession(def: CaseDef, init: Pick<CaseSession, "runId" | "replay" | "baseFlags" | "startPatches" | "priorLog" | "clock">): CaseSession {
  return {
    caseId: def.id,
    phase: "intro",
    startedAt: Date.now(),
    flags: {},
    patches: [],
    log: [],
    journal: [],
    queryCount: 0,
    queries: 0,
    errors: 0,
    consecutiveErrors: 0,
    completed: [],
    attempts: {},
    hints: [],
    freeHintTokens: 0,
    withHint: [],
    predictions: {},
    hintOffer: null,
    seen: [],
    seenOptions: [],
    evidence: [],
    pins: [],
    slots: {},
    protocolConfirmed: [],
    protocolAttempts: 0,
    protocolFailures: 0,
    protocolMessage: null,
    accusations: {},
    interrogations: {},
    closedAt: {},
    breaks: {},
    endedScenes: [],
    firedEvents: [],
    stage: null,
    queue: [],
    interrogation: null,
    closingScene: null,
    history: [],
    draftSql: def.starterSql ?? "",
    debrief: null,
    ...init,
  };
}

/** Лучшие очки сезона — основа звания */
export function seasonPoints(solved: Record<string, SolvedCase>): number {
  return Object.values(solved).reduce((sum, s) => sum + s.bestPoints, 0);
}

/** Дело открыто в календаре: первое по порядку или предыдущее раскрыто */
export function isCaseUnlocked(caseId: string, cases: readonly CaseDef[], solved: Record<string, SolvedCase>): boolean {
  const ordered = [...cases].sort((a, b) => a.order - b.order);
  const i = ordered.findIndex((c) => c.id === caseId);
  if (i < 0) return false;
  return i === 0 || Boolean(solved[ordered[i - 1].id]) || Boolean(solved[caseId]);
}

/** Есть ли у дела играбельный контент */
export const casePlayable = (def: CaseDef) => def.objectives.length > 0;

// --- Сцены: чистые переходы над сессией ---

function choicesAvailable(scene: Scene, evidence: ReadonlySet<string>) {
  return (scene.choices ?? []).filter((c) => (c.requires ?? []).every((id) => evidence.has(id)));
}

interface SceneCtx {
  def: CaseDef;
  evidence: ReadonlySet<string>;
}

function startScene(s: CaseSession, ctx: SceneCtx, sceneId: string): CaseSession {
  const scene = getScene(ctx.def, sceneId);
  if (!scene) return nextFromQueue(s, ctx);
  if (scene.interrogation) {
    const saved = s.interrogations[sceneId];
    // окончен или «закрылся» — лента пропускается (вернуться: reopenInterrogation)
    if (saved?.done || saved?.closed) return afterScene(s, ctx, sceneId);
    return { ...s, stage: null, interrogation: { sceneId, state: saved ?? startInterrogation(scene.interrogation) } };
  }
  if (scene.lines.length === 0) return reachEnd({ ...s, stage: { sceneId, line: 0 } }, ctx, scene);
  return { ...s, stage: { sceneId, line: 0 } };
}

function reachEnd(s: CaseSession, ctx: SceneCtx, scene: Scene): CaseSession {
  const line = Math.max(0, scene.lines.length - 1);
  if (choicesAvailable(scene, ctx.evidence).length > 0) return { ...s, stage: { sceneId: scene.id, line, awaiting: "choice" } };
  if (scene.present) return { ...s, stage: { sceneId: scene.id, line, awaiting: "present" } };
  return afterScene(s, ctx, scene.id);
}

function afterScene(s: CaseSession, ctx: SceneCtx, sceneId: string): CaseSession {
  const ended: CaseSession = { ...s, stage: null, endedScenes: pushUniq(s.endedScenes, sceneId) };
  const next = getScene(ctx.def, sceneId)?.next;
  return next ? startScene(ended, ctx, next) : nextFromQueue(ended, ctx);
}

function nextFromQueue(s: CaseSession, ctx: SceneCtx): CaseSession {
  if (s.queue.length > 0) {
    const [head, ...rest] = s.queue;
    const popped = { ...s, queue: rest };
    return head.awaiting ? { ...popped, stage: head } : startScene(popped, ctx, head.sceneId);
  }
  if (s.interrogation) {
    const { state, sceneId } = s.interrogation;
    if (state.done || state.closed) {
      const closed: CaseSession = {
        ...s,
        interrogation: null,
        interrogations: { ...s.interrogations, [sceneId]: state },
        breaks: { ...s.breaks, [sceneId]: state.broken.length },
      };
      return afterScene(closed, ctx, sceneId);
    }
    return { ...s, stage: null };
  }
  return { ...s, stage: null, phase: s.phase === "intro" ? "desk" : s.phase };
}

/** Поставить сцены в очередь: если ничего не играет (или идёт лента допроса) — начать сразу */
function enqueueScenes(s: CaseSession, ctx: SceneCtx, ids: readonly (string | undefined)[]): CaseSession {
  const slots: StageSlot[] = ids.filter((id): id is string => Boolean(id)).map((sceneId) => ({ sceneId, line: 0 }));
  if (slots.length === 0) return s;
  const queued = { ...s, queue: [...s.queue, ...slots] };
  return s.stage === null ? nextFromQueue(queued, ctx) : queued;
}

// --- Фабрика ---

export function createGameStore(options: GameStoreOptions = {}): GameStore {
  const cases = options.cases ?? seasonCases;
  const achievementDefs = options.achievements ?? seasonAchievements;
  const secretDefs = options.secrets ?? seasonSecrets;
  const now = options.now ?? (() => new Date());
  const caseById = (id: string) => cases.find((c) => c.id === id);
  const finalOrder = Math.max(...cases.map((c) => c.order));

  let client: EngineClient | null = null;
  let openedCase: string | null = null;
  let barkSeq = 0;
  let initPromise: Promise<void> | null = null;

  const engine = (): EngineClient => {
    if (!client) {
      client =
        options.engine?.() ??
        createEngineClient({ secrets: secretDefs, ...options.engineOptions });
    }
    return client;
  };

  const store = createStore<GameState>()(
    persist(
      (set, get) => {
        // --- служебные ---

        const def = (): CaseDef | undefined => {
          const s = get().session;
          return s ? caseById(s.caseId) : undefined;
        };

        const sceneCtx = (s: CaseSession, d: CaseDef): SceneCtx => ({
          def: d,
          evidence: new Set([...get().season.evidence, ...s.evidence]),
        });

        const patchSession = (fn: (s: CaseSession) => CaseSession) => {
          const s = get().session;
          if (s) set({ session: fn(s) });
        };

        const bark = (kind: BarkKind, speaker: string, text: string, extra: Partial<Bark> = {}) => {
          const item: Bark = { id: ++barkSeq, kind, speaker, text, ...extra };
          set((st) => ({ barks: [...st.barks, item].slice(-MAX_BARKS) }));
        };

        const toast = (kind: "secret" | "achievement", refId: string) =>
          set((st) => ({ toasts: [...st.toasts, { id: ++barkSeq, kind, refId }] }));

        const recordEvents = (...ids: string[]) =>
          set((st) => ({ season: { ...st.season, events: pushUniq(st.season.events, ...ids) } }));

        const syncJournal = () => {
          if (client) patchSession((s) => ({ ...s, journal: [...client!.getJournal()] }));
        };

        /** Флаги сезона для достижений и концовки: ранние дела + текущее */
        const seasonFlags = (): Flags => {
          const st = get();
          const merged = [...cases]
            .sort((a, b) => a.order - b.order)
            .reduce<Flags>((acc, c) => ({ ...acc, ...(st.season.caseFlags[c.id] ?? {}) }), {});
          return st.session ? { ...merged, ...st.session.flags } : merged;
        };

        /** Записи диктофона Ирины, дослушанные в этом деле: события note_heard:* и счётчик notes_heard */
        const syncNotes = () => {
          const s = get().session;
          const d = def();
          if (!s || !d) return;
          const heard = s.endedScenes
            .filter((id) => {
              const scene = getScene(d, id);
              return scene !== undefined && isIrinaNote(scene);
            })
            .map((id) => `note_heard:${d.id}/${id}`);
          const season = get().season;
          const events = pushUniq(season.events, ...heard);
          if (events.length === season.events.length) return;
          const notes = events.filter((e) => e.startsWith("note_heard:")).length;
          set({ season: { ...season, events, counters: { ...season.counters, notes_heard: notes } } });
        };

        const checkAch = (): string[] => {
          syncNotes();
          const st = get();
          const fresh = checkAchievements(achievementDefs, {
            solved: Object.values(st.season.solved).map((s) => ({ caseId: s.caseId, stats: s.stats, stars: s.stars })),
            secretsFound: st.season.foundSecrets.length,
            seasonComplete: cases.every((c) => st.season.solved[c.id]),
            earned: new Set(st.season.achievements),
            flags: seasonFlags(),
            counters: st.season.counters,
            events: new Set(st.season.events),
          });
          if (fresh.length) {
            set((x) => ({ season: { ...x.season, achievements: [...x.season.achievements, ...fresh] } }));
            fresh.forEach((id) => toast("achievement", id));
          }
          return fresh;
        };

        const openInEngine = async (s: CaseSession, d: CaseDef) => {
          const c = engine();
          await c.init((progress) => set((st) => ({ loading: { ...st.loading, progress } })));
          const opened = await c.openCase(d, {
            ...(get().profile.playerName ? { playerName: get().profile.playerName } : {}),
            patches: s.startPatches,
            queryLog: s.priorLog,
            journal: s.journal,
          });
          openedCase = `${s.caseId}#${s.runId}`;
          set({ schema: opened.schema, foreignKeys: opened.foreignKeys, playerViews: opened.playerViews });
          patchSession((x) => ({ ...x, clock: opened.clock, journal: [...c.getJournal()] }));
        };

        const ensureOpen = async () => {
          const s = get().session;
          const d = def();
          if (!s || !d) return false;
          if (openedCase !== `${s.caseId}#${s.runId}`) await openInEngine(s, d);
          return true;
        };

        /** Живые события дела (разд. 6.10): сцена, патч мира, реплика, перевод часов */
        const processEvents = async () => {
          for (let guard = 0; guard < 16; guard++) {
            const s = get().session;
            const d = def();
            if (!s || !d || s.phase === "debrief") return;
            const due = dueEvents(d, {
              completed: new Set(s.completed),
              endedScenes: new Set(s.endedScenes),
              breaks: s.breaks,
              flags: effectiveFlags(s),
              noTimer: get().settings.noTimer,
              queryCount: s.queryCount,
              now: s.clock,
              fired: new Set(s.firedEvents),
            });
            if (due.length === 0) return;
            for (const ev of due) {
              patchSession((x) => ({ ...x, firedEvents: pushUniq(x.firedEvents, ev.id) }));
              if (ev.patch) {
                const params = patchParams(get().session!, d, ev.patch);
                const applied = await engine().applyPatch(ev.patch, params);
                set({ schema: applied.schema, foreignKeys: applied.foreignKeys });
                // В следующие дела патч переходит с теми же флагами и часами применения
                const request = { id: ev.patch, params: { ...params, clock: applied.clock } };
                patchSession((x) => ({ ...x, clock: applied.clock, patches: [...x.patches, request] }));
                if (applied.rolledBack) bark("system", MIRA, ROLLBACK_LINE);
              }
              if (ev.clockTo) {
                const cur = get().session!.clock;
                const target = applyClockTo(cur, ev);
                if (target !== cur) {
                  const clock = await engine().setClock(target);
                  patchSession((x) => ({ ...x, clock }));
                }
              }
              if (ev.line) bark("event", ev.line.split(".")[0] === "sys" ? "system" : MIRA, ev.line, { lineId: ev.line });
              if (ev.scene) patchSession((x) => enqueueScenes(x, sceneCtx(x, d), [ev.scene]));
              syncJournal();
            }
          }
        };

        /** Закрыть дело, когда доиграна финальная сцена (протокол / outro) или задачи без протокола */
        const maybeClose = () => {
          const s = get().session;
          const d = def();
          if (!s || !d || s.phase === "debrief") return;
          // Финал без протокола — только когда сюжет стоит: сцена, очередь или допрос могут
          // ещё выставить флаг условной задачи (Д8: кода после допроса Тохи)
          const resting = s.stage === null && s.queue.length === 0 && s.interrogation === null;
          const accusing = (d.accusations ?? []).some((a) => a.required && !s.accusations[a.id]?.accepted);
          if (!d.protocol && s.closingScene === null && resting && !accusing && isCaseObjectivesDone(d, new Set(s.completed), effectiveFlags(s))) {
            const closing = d.outroScene ?? "";
            // Финальная сцена уже доиграна по сюжету (Д8: кода → outro) — второй раз её не показываем
            const played = closing !== "" && s.endedScenes.includes(closing);
            patchSession((x) =>
              played ? { ...x, closingScene: closing } : enqueueScenes({ ...x, closingScene: closing }, sceneCtx(x, d), [d.outroScene])
            );
          }
          const after = get().session!;
          const idle = after.stage === null && after.queue.length === 0 && after.interrogation === null;
          if (after.closingScene !== null && idle && (after.closingScene === "" || after.endedScenes.includes(after.closingScene))) {
            completeCase();
          }
        };

        const afterStory = async () => {
          await processEvents();
          maybeClose();
          checkAch();
        };

        const completeObjective = (s: CaseSession, d: CaseDef, c: CompletedObjective, sql?: string): CaseSession => {
          const obj = d.objectives.find((o) => o.id === c.objectiveId);
          const hintsFor = s.hints.filter((h) => h.objectiveId === c.objectiveId);
          const firstTry = !c.optional && (s.attempts[c.objectiveId] ?? 0) <= 1;
          const key = `${d.id}/${c.objectiveId}`;
          recordEvents(
            `objective_done:${key}`,
            ...(firstTry ? [`objective_first_try:${key}`] : []),
            ...(hintsFor.length === 0 ? [`objective_no_hint:${key}`] : []),
            // «Из будущего»: задача решена понятием, которое вводит более позднее дело
            ...(sql && futureConcepts(sql, d, cases).length > 0 ? ["future_concept"] : [])
          );
          if (firstTry && obj?.concept) {
            set((st) => ({ season: { ...st.season, mastery: bumpMastery(st.season.mastery, obj.concept, MASTERY.firstTry) } }));
          }
          bark("objective", MIRA, c.message);
          let next: CaseSession = {
            ...s,
            completed: pushUniq(s.completed, c.objectiveId),
            evidence: c.evidence ? pushUniq(s.evidence, c.evidence.id) : s.evidence,
            hintOffer: s.hintOffer === c.objectiveId ? null : s.hintOffer,
            history: sql
              ? s.history.map((h, i) => (i === s.history.length - 1 && !h.objectiveId ? { ...h, objectiveId: c.objectiveId } : h))
              : s.history,
          };
          if (c.sceneAfter) next = enqueueScenes(next, sceneCtx(next, d), [c.sceneAfter]);
          return next;
        };

        const completeCase = () => {
          const st = get();
          const s = st.session;
          const d = def();
          if (!s || !d) return;
          const flags = effectiveFlags(s);
          const optional = optionalObjectives(d, flags);
          const stats: CaseStats = {
            queries: s.queries,
            errors: s.errors,
            hintsUsed: s.hints.filter((h) => !h.free).length,
            protocolAttempts: d.protocol ? s.protocolAttempts : 0,
            optionalDone: optional.filter((o) => s.completed.includes(o.id)).length,
            optionalTotal: optional.length,
            durationMs: Date.now() - s.startedAt,
          };
          const score = scoreCase(stats, d);
          const weather = weatherFor(score.stars, stats.optionalDone, stats.optionalTotal);
          const rankBefore = rankFor(seasonPoints(st.season.solved));
          const prev = st.season.solved[d.id];
          const solved: SolvedCase = {
            caseId: d.id,
            stats,
            score,
            stars: score.stars,
            weather,
            bestPoints: Math.max(prev?.bestPoints ?? 0, score.points),
            bestStars: Math.max(prev?.bestStars ?? 1, score.stars) as SolvedCase["bestStars"],
            runs: (prev?.runs ?? 0) + 1,
            solvedAt: now().toISOString(),
          };

          // переигровка поменяла флаги — у следующих дел «последствия изменились»
          const flagsChanged = prev !== undefined && !sameFlags(st.season.caseFlags[d.id], s.flags);
          const solvedAll: Record<string, SolvedCase> = { ...st.season.solved, [d.id]: solved };
          if (flagsChanged) {
            for (const c of cases) {
              if (c.order > d.order && solvedAll[c.id]) solvedAll[c.id] = { ...solvedAll[c.id], consequencesChanged: true };
            }
          }

          // Ночь после дела: задания zero, чьё условие выполнено (М6), — патчи для следующих дел
          const earlierPatches = cases.filter((c) => c.order < d.order).flatMap((c) => st.season.casePatches[c.id] ?? []);
          const cron = cronFiresAfterCase(d.order, s.seen, firedCronJobs([...earlierPatches, ...s.patches]), s.clock).map((params) => ({
            id: CRON_PATCH,
            params,
          }));

          const hour = now().getHours();
          set({
            season: {
              ...st.season,
              solved: solvedAll,
              caseFlags: { ...st.season.caseFlags, [d.id]: s.flags },
              casePatches: { ...st.season.casePatches, [d.id]: [...s.patches, ...cron] },
              caseQueryLog: { ...st.season.caseQueryLog, [d.id]: s.log },
              evidence: pushUniq(st.season.evidence, ...s.evidence),
              events: pushUniq(
                st.season.events,
                `case_solved:${d.id}`,
                ...(hour < 5 ? ["solved_after_midnight"] : []),
                // «Палец не дрогнул»: дело закрыто, а его растяжка (after.flag живого события) не задета
                ...tripFlags(d).filter((f) => !flagRaised(flags[f])).map((f) => `case_solved_without:${d.id}/${f}`)
              ),
            },
          });

          let ending: EndingResult | null = null;
          if (d.order === finalOrder) {
            ending = computeEnding(seasonFlags(), { noTimer: st.settings.noTimer });
            const seen = pushUniq(get().season.endingsSeen, ending.id);
            set((x) => ({
              season: {
                ...x.season,
                ending,
                endingsSeen: seen,
                counters: { ...x.season.counters, endings_seen: seen.length },
                events: pushUniq(
                  x.season.events,
                  `ending:${ending!.id}`,
                  ...((x.season.counters.evidence_deletes ?? 0) === 0 ? ["season_no_evidence_delete"] : [])
                ),
              },
            }));
          }
          const newAchievements = checkAch();
          const after = get().season;
          const ordered = [...cases].sort((a, b) => a.order - b.order);
          const next = ordered.find((c) => c.order > d.order && casePlayable(c));
          const debrief: Debrief = {
            caseId: d.id,
            stats,
            score,
            stars: score.stars,
            weather,
            weatherLabel: WEATHER_LABELS[weather],
            rankBefore,
            rankAfter: rankFor(seasonPoints(after.solved)),
            seasonPoints: seasonPoints(after.solved),
            newAchievements,
            objectives: d.objectives
              .filter((o) => objectiveApplies(o, flags))
              .sort((a, b) => a.order - b.order)
              .map((o) => {
                const hints = s.hints.filter((h) => h.objectiveId === o.id);
                const done = s.completed.includes(o.id);
                return {
                  id: o.id,
                  task: o.task,
                  optional: Boolean(o.optional),
                  done,
                  solution: o.solution,
                  ...(done ? { playerSql: s.history.find((h) => h.objectiveId === o.id)?.sql } : {}),
                  firstTry: done && !o.optional && (s.attempts[o.id] ?? 0) <= 1,
                  withHint: s.withHint.includes(o.id),
                  hintsUsed: hints.length,
                };
              }),
            nextCaseId: next && isCaseUnlocked(next.id, cases, after.solved) ? next.id : null,
            ending,
          };
          patchSession((x) => ({ ...x, phase: "debrief", debrief, stage: null, queue: [] }));
        };

        const offeredFrom = (s: CaseSession, offer: OfferInput): OfferedEvidence => ({
          evidenceIds: [...(offer.evidenceIds ?? [])],
          cards: s.pins.filter((p) => offer.cardIds?.includes(p.id)),
        });

        // --- действия ---

        return {
          ...defaultPersisted(),
          ...initialTransient(),

          async boot() {
            if (!initPromise) {
              initPromise = (async () => {
                if (options.skipHydration) await store.persist.rehydrate();
                set((st) => ({ loading: { ...st.loading, status: "loading", error: null } }));
                try {
                  const info = await engine().init((progress) => set((st) => ({ loading: { ...st.loading, progress } })));
                  set((st) => ({ loading: { ...st.loading, status: "ready", fromCache: info.fromCache } }));
                  const s = get().session;
                  const d = def();
                  if (s && d) await openInEngine(s, d);
                  else if (s) set({ session: null });
                } catch (error) {
                  initPromise = null;
                  set((st) => ({
                    loading: { ...st.loading, status: "failed", error: error instanceof Error ? error.message : String(error) },
                  }));
                }
              })();
            }
            return initPromise;
          },

          confirmAge: () => set((st) => ({ profile: { ...st.profile, ageConfirmed: true } })),
          markColdOpenSeen: () => set((st) => ({ profile: { ...st.profile, coldOpenSeen: true } })),
          setProfile: (patch) => set((st) => ({ profile: { ...st.profile, ...patch } })),
          updateSettings: (patch) => set((st) => ({ settings: { ...st.settings, ...patch } })),

          resetSeason() {
            openedCase = null;
            const fresh = defaultPersisted();
            set((st) => ({ season: fresh.season, session: null, profile: { ...st.profile, onboarded: false }, last: null, barks: [], toasts: [] }));
          },

          async openCase(caseId) {
            const st = get();
            const d = caseById(caseId);
            if (!d || !casePlayable(d) || !isCaseUnlocked(caseId, cases, st.season.solved)) return false;
            if (st.session?.caseId === caseId && st.session.phase !== "debrief") {
              await ensureOpen();
              return true;
            }
            const earlier = [...cases].filter((c) => c.order < d.order).sort((a, b) => a.order - b.order);
            const run = (st.season.runs[caseId] ?? 0) + 1;
            const session = newSession(d, {
              runId: `${caseShort(d)}-r${run}`,
              replay: Boolean(st.season.solved[caseId]),
              baseFlags: flagsBefore(d, cases, st.season.caseFlags),
              startPatches: earlier.flatMap((c) => st.season.casePatches[c.id] ?? []),
              priorLog: earlier.flatMap((c) => st.season.caseQueryLog[c.id] ?? []),
              clock: d.date,
            });
            set({
              session,
              last: null,
              barks: [],
              season: { ...st.season, runs: { ...st.season.runs, [caseId]: run } },
            });
            await openInEngine(session, d);
            patchSession((x) => startScene(x, sceneCtx(x, d), d.introScene));
            await afterStory();
            return true;
          },

          async restartCase() {
            if (!(await ensureOpen())) return;
            const opened = await engine().resetCase();
            set({ schema: opened.schema, foreignKeys: opened.foreignKeys, playerViews: opened.playerViews });
            patchSession((x) => ({ ...x, clock: opened.clock, journal: [...engine().getJournal()] }));
          },

          abandonCase() {
            openedCase = null;
            set({ session: null, last: null, barks: [] });
          },

          finishDebrief() {
            if (get().session?.phase !== "debrief") return;
            openedCase = null;
            set({ session: null, last: null, barks: [] });
          },

          // --- сцены ---

          async playScene(sceneId) {
            const d = def();
            if (!d) return;
            patchSession((x) => enqueueScenes(x, sceneCtx(x, d), [sceneId]));
            await afterStory();
          },

          async advance() {
            const s = get().session;
            const d = def();
            if (!s?.stage || !d || s.stage.awaiting) return;
            const scene = getScene(d, s.stage.sceneId);
            if (!scene) return;
            if (s.stage.line < scene.lines.length - 1) {
              set({ session: { ...s, stage: { ...s.stage, line: s.stage.line + 1 } } });
              return;
            }
            set({ session: reachEnd(s, sceneCtx(s, d), scene) });
            await afterStory();
          },

          async skipScene() {
            const s = get().session;
            const d = def();
            if (!s?.stage || !d || s.stage.awaiting) return;
            const scene = getScene(d, s.stage.sceneId);
            if (!scene) return;
            set({ session: reachEnd(s, sceneCtx(s, d), scene) });
            await afterStory();
          },

          async choose(choiceId) {
            const s = get().session;
            const d = def();
            if (!s?.stage || !d || s.stage.awaiting !== "choice") return;
            const scene = getScene(d, s.stage.sceneId);
            const ctx = sceneCtx(s, d);
            const choice = scene && choicesAvailable(scene, ctx.evidence).find((c) => c.id === choiceId);
            if (!scene || !choice) return;
            const flagged: CaseSession = choice.flag ? withFlag(s, choice.flag) : s;
            const ended: CaseSession = { ...flagged, stage: null, endedScenes: pushUniq(flagged.endedScenes, scene.id) };
            const target = choice.goto ?? scene.next;
            set({ session: target ? startScene(ended, ctx, target) : nextFromQueue(ended, ctx) });
            await afterStory();
          },

          async presentInScene(offer) {
            const s = get().session;
            const d = def();
            if (!s?.stage || !d || s.stage.awaiting !== "present") return false;
            const scene = getScene(d, s.stage.sceneId);
            if (!scene?.present) return false;
            const ok = presentMatches(scene.present, offeredFrom(s, offer));
            const ctx = sceneCtx(s, d);
            if (ok) {
              const ended: CaseSession = { ...s, stage: null, endedScenes: pushUniq(s.endedScenes, scene.id) };
              set({ session: startScene(ended, ctx, scene.present.success) });
            } else {
              const retry: CaseSession = { ...s, stage: null, queue: [{ ...s.stage }, ...s.queue] };
              set({ session: startScene(retry, ctx, scene.present.failure) });
            }
            await afterStory();
            return ok;
          },

          // --- стол ---

          setDraft: (sql) => patchSession((x) => ({ ...x, draftSql: sql })),

          async runQuery(sqlIn) {
            const st = get();
            const s0 = st.session;
            const d = def();
            if (!s0 || !d || st.busy || s0.phase === "debrief") return null;
            const sql = (sqlIn ?? s0.draftSql).trim();
            if (!sql) return null;
            if (d.queryBudget !== undefined && s0.queryCount >= d.queryBudget) {
              bark("system", MIRA, BUDGET_LINE);
              return null;
            }
            set({ busy: true });
            let ev: Evaluation;
            try {
              await ensureOpen();
              const flags = effectiveFlags(s0);
              const ctx: RunContext = {
                completed: s0.completed,
                seen: s0.seen,
                pins: s0.pins,
                slots: s0.slots,
                flags,
                foundSecrets: st.season.foundSecrets,
                endedScenes: s0.endedScenes,
                breaks: s0.breaks,
                noTimer: st.settings.noTimer,
                runId: s0.runId,
              };
              ev = await engine().run(sql, ctx);
            } catch (error) {
              set({ busy: false });
              bark("system", MIRA, `Ядро не ответило: ${error instanceof Error ? error.message : String(error)}`);
              return null;
            }

            const s = get().session;
            if (!s || s.caseId !== d.id) {
              set({ busy: false });
              return ev;
            }
            const flags = effectiveFlags(s);
            const active = activeObjective(d, new Set(s.completed), flags);
            const failed = Boolean(ev.result.error);
            const logEntry: PlayerQueryEntry | null = ev.logEntry;
            const newOptions = ev.seenOptions.filter((o) => !s.seenOptions.includes(o));

            let next: CaseSession = {
              ...s,
              clock: ev.clock,
              queryCount: s.queryCount + (ev.clockMoved ? 1 : 0),
              queries: s.queries + 1,
              errors: s.errors + (failed ? 1 : 0),
              consecutiveErrors: failed ? s.consecutiveErrors + 1 : 0,
              attempts: active && !failed ? { ...s.attempts, [active.id]: (s.attempts[active.id] ?? 0) + 1 } : s.attempts,
              seen: uniq([...s.seen, ...ev.seen]),
              seenOptions: uniq([...s.seenOptions, ...ev.seenOptions]),
              log: logEntry ? [...s.log, logEntry] : s.log,
              journal: [...engine().getJournal()],
              history: [
                ...s.history,
                {
                  sql,
                  ok: !failed,
                  rows: ev.result.rowCount,
                  clock: ev.clock,
                  ms: ev.ms,
                  ...(failed ? { error: ev.result.error ?? "" } : {}),
                },
              ],
            };
            if (next.consecutiveErrors >= 3 && active && !next.hintOffer) next = { ...next, hintOffer: active.id };
            for (const c of ev.progress.completed) next = completeObjective(next, d, c, sql);

            set({
              session: next,
              busy: false,
              playerViews: ev.playerViews,
              last: {
                sql,
                result: ev.result,
                newOptions,
                lint: ev.lint,
                completed: ev.progress.completed.map((c) => c.objectiveId),
                feedback: ev.progress.activeFeedback,
                recovered: Boolean(ev.recovery),
              },
            });

            for (const w of ev.lint) bark("lint", w.speaker, w.text, { lineId: w.lineId, ...(w.detail ? { detail: w.detail } : {}) });
            if (ev.secrets.length) {
              set((x) => ({ season: { ...x.season, foundSecrets: pushUniq(x.season.foundSecrets, ...ev.secrets) } }));
              ev.secrets.forEach((id) => toast("secret", id));
            }
            recordEvents("first_query", ...(ev.recovery?.reason === "timeout" ? ["query_timeout"] : []));
            if (!ev.result.error && deletesEvidence(sql)) {
              set((x) => ({ season: { ...x.season, counters: { ...x.season.counters, evidence_deletes: (x.season.counters.evidence_deletes ?? 0) + 1 } } }));
            }

            await afterStory();
            return ev;
          },

          revealHint(objectiveId) {
            const st = get();
            const s = st.session;
            const d = def();
            if (!s || !d) return null;
            const obj = objectiveId
              ? d.objectives.find((o) => o.id === objectiveId)
              : activeObjective(d, new Set(s.completed), effectiveFlags(s));
            if (!obj || s.completed.includes(obj.id)) return null;
            const shown = s.hints.filter((h) => h.objectiveId === obj.id).reduce((m, h) => Math.max(m, h.tier), 0);
            const maxTier = Math.min(HINT_TIERS, obj.hints.length);
            let tier = shown + 1;
            while (tier <= maxTier && !hintTierAllowed(st.profile.mode, tier)) tier++;
            if (tier > maxTier) return null;
            let free = hintTierFree(st.profile.mode, tier, d, obj.concept);
            let tokens = s.freeHintTokens;
            if (!free && tokens > 0) {
              free = true;
              tokens--;
            }
            const reveal: HintReveal = { objectiveId: obj.id, tier, free };
            set({
              session: {
                ...s,
                hints: [...s.hints, reveal],
                freeHintTokens: tokens,
                withHint: tier >= HINT_TIERS ? pushUniq(s.withHint, obj.id) : s.withHint,
                hintOffer: null,
              },
              season: d.difficulty === "tutorial" ? st.season : { ...st.season, mastery: bumpMastery(st.season.mastery, obj.concept, MASTERY.hint) },
            });
            const hint: HintDef | undefined = obj.hints[tier - 1];
            if (hint) bark("system", hint.by ?? MIRA, hint.text, hint.line ? { lineId: hint.line } : {});
            return reveal;
          },

          offerHint() {
            const s = get().session;
            const d = def();
            if (!s || !d) return;
            const active = activeObjective(d, new Set(s.completed), effectiveFlags(s));
            if (active) patchSession((x) => ({ ...x, hintOffer: active.id }));
          },

          dismissHintOffer: () => patchSession((x) => ({ ...x, hintOffer: null })),

          answerPrediction(objectiveId, answer) {
            const st = get();
            const s = st.session;
            const obj = def()?.objectives.find((o) => o.id === objectiveId);
            if (!s || !obj?.prediction || s.predictions[objectiveId] || !predictionsEnabled(st.profile.mode)) return false;
            const correct = obj.prediction.answer === answer;
            set({
              session: { ...s, predictions: { ...s.predictions, [objectiveId]: { answer, correct } } },
              ...(correct ? { season: { ...st.season, mastery: bumpMastery(st.season.mastery, obj.concept, MASTERY.prediction) } } : {}),
            });
            if (obj.prediction.explanation) bark("system", MIRA, obj.prediction.explanation);
            return correct;
          },

          pinRow(rowIndex) {
            const st = get();
            const s = st.session;
            const last = st.last;
            if (!s || !last || last.result.error) return null;
            const row = last.result.rows[rowIndex];
            if (!row) return null;
            const card = makeCard(row, last.result.columns, last.sql, s.clock);
            if (s.pins.some((p) => p.fingerprint === card.fingerprint)) return s.pins.find((p) => p.fingerprint === card.fingerprint)!;
            set({ session: { ...s, pins: [...s.pins, card] } });
            return card;
          },

          pinAll() {
            const last = get().last;
            if (!last || last.result.error || last.result.rows.length === 0 || last.result.rows.length > PIN_ALL_LIMIT) return 0;
            let added = 0;
            last.result.rows.forEach((_, i) => {
              const before = get().session?.pins.length ?? 0;
              get().pinRow(i);
              if ((get().session?.pins.length ?? 0) > before) added++;
            });
            return added;
          },

          unpin: (cardId) => patchSession((x) => ({ ...x, pins: x.pins.filter((p) => p.id !== cardId) })),

          setCardNode: (cardId, node) =>
            patchSession((x) => ({
              ...x,
              pins: x.pins.map((p) => {
                if (p.id !== cardId) return p;
                const { node: _old, ...rest } = p;
                void _old;
                return node ? { ...rest, node } : rest;
              }),
            })),

          dismissBark: (id) => set((st) => ({ barks: st.barks.filter((b) => b.id !== id) })),
          dismissToast: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })),

          // --- протокол ---

          setSlot(blankId, value) {
            const s = get().session;
            const blank = def()?.protocol?.blanks.find((b) => b.id === blankId);
            if (!s || !blank || s.protocolConfirmed.includes(blankId)) return false;
            if (value !== "") {
              const allowed = availableOptions(blank, new Set(s.seen));
              if (!allowed.includes(value)) return false;
            }
            const slots = { ...s.slots };
            if (value === "") delete slots[blankId];
            else slots[blankId] = value;
            set({ session: { ...s, slots } });
            return true;
          },

          async submitProtocol() {
            const s = get().session;
            const d = def();
            if (!s || !d?.protocol || s.phase === "debrief" || s.closingScene !== null) return;
            const check = checkProtocol(d.protocol, s.slots, new Set(s.protocolConfirmed));
            const attempts = s.protocolAttempts + 1;
            const failures = s.protocolFailures + (check.solved ? 0 : 1);
            let next: CaseSession = {
              ...s,
              protocolAttempts: attempts,
              protocolFailures: failures,
              protocolConfirmed: check.confirmed,
              protocolMessage: check.message,
              // после второй неудачной сверки следующий уровень подсказки бесплатен (разд. 6.7)
              freeHintTokens: !check.solved && failures === 2 ? s.freeHintTokens + 1 : s.freeHintTokens,
            };
            bark("protocol", MIRA, check.message);
            if (!check.solved) {
              const line = protocolFailureLine(d.protocol, failures);
              if (line) bark("protocol", "narrator", line);
            } else {
              next = enqueueScenes({ ...next, closingScene: d.protocol.successScene }, sceneCtx(next, d), [d.protocol.successScene]);
              recordEvents(...(attempts === 1 ? [`protocol_first_try:${d.id}`] : []));
            }
            set({ session: next });
            await afterStory();
          },

          // --- обвинение ---

          async accuse(accusationId, accused, cardIds) {
            const s = get().session;
            const d = def();
            const acc = d?.accusations?.find((a) => a.id === accusationId);
            if (!s || !d || !acc || s.accusations[accusationId]?.accepted) return null;
            const attached = s.pins.filter((p) => cardIds.includes(p.id));
            const check = checkAccusation(acc, accused, attached);
            const prevState = s.accusations[accusationId] ?? { attempts: 0, accepted: false };
            let next: CaseSession = {
              ...s,
              accusations: {
                ...s.accusations,
                [accusationId]: { attempts: prevState.attempts + 1, accepted: check.outcome === "accepted" },
              },
            };
            if (check.trustFlag) next = shiftSessionFlag(next, check.trustFlag, -1);
            if (check.outcome === "accepted" && acc.objective && !next.completed.includes(acc.objective)) {
              const obj = d.objectives.find((o) => o.id === acc.objective);
              if (obj) {
                next = completeObjective(next, d, {
                  objectiveId: obj.id,
                  message: obj.success,
                  ...(obj.evidence ? { evidence: obj.evidence } : {}),
                  ...(obj.optional ? { optional: true as const } : {}),
                });
              }
            }
            if (check.scene) next = enqueueScenes(next, sceneCtx(next, d), [check.scene]);
            set({ session: next });
            bark("accusation", MIRA, check.message);
            await afterStory();
            return check;
          },

          // --- допрос ---

          async pressStatement(line) {
            const s = get().session;
            const d = def();
            if (!s?.interrogation || !d || s.stage) return;
            const idef = getScene(d, s.interrogation.sceneId)?.interrogation;
            if (!idef) return;
            const out = pressPoint(idef, s.interrogation.state, line);
            const next: CaseSession = { ...s, interrogation: { ...s.interrogation, state: out.state } };
            set({ session: enqueueScenes(next, sceneCtx(next, d), [out.scene]) });
            await afterStory();
          },

          async presentToSuspect(line, offer) {
            const s = get().session;
            const d = def();
            if (!s?.interrogation || !d || s.stage) return;
            const sceneId = s.interrogation.sceneId;
            const idef = getScene(d, sceneId)?.interrogation;
            if (!idef) return;
            const out = presentEvidence(idef, s.interrogation.state, line, offeredFrom(s, offer));
            if (out.result === "ignored") return;
            let next: CaseSession = {
              ...s,
              interrogation: { sceneId, state: out.state },
              interrogations: { ...s.interrogations, [sceneId]: out.state },
              breaks: { ...s.breaks, [sceneId]: out.state.broken.length },
            };
            if (out.trust) next = shiftSessionFlag(next, out.trust.flag, out.trust.delta);
            if (out.state.closed) next = { ...next, closedAt: { ...next.closedAt, [sceneId]: next.pins.length + next.evidence.length } };
            const scenes = [out.scene, out.result === "break" && out.state.done ? idef.doneScene : undefined];
            next = enqueueScenes(next, sceneCtx(next, d), scenes);
            // ничего не играет, а допрос окончен — закрыть ленту
            if (!next.stage && next.queue.length === 0 && (out.state.done || out.state.closed)) next = nextFromQueue(next, sceneCtx(next, d));
            set({ session: next });
            await afterStory();
          },

          reopenInterrogation(sceneId) {
            const s = get().session;
            const d = def();
            const idef = d && getScene(d, sceneId)?.interrogation;
            const saved = s?.interrogations[sceneId];
            if (!s || !idef || !saved || s.interrogation || s.stage) return false;
            if (s.pins.length + s.evidence.length <= (s.closedAt[sceneId] ?? Infinity)) return false;
            const state = engineReopen(idef, saved);
            if (!state) return false;
            set({ session: { ...s, interrogation: { sceneId, state }, interrogations: { ...s.interrogations, [sceneId]: state } } });
            return true;
          },

          // --- сюжет и прогрессия ---

          async setFlag(name, value) {
            patchSession((x) => ({ ...x, flags: { ...x.flags, [name]: value } }));
            await afterStory();
          },

          recordEvent(id) {
            recordEvents(id);
            checkAch();
          },

          bumpCounter(name, by = 1) {
            set((st) => ({ season: { ...st.season, counters: { ...st.season.counters, [name]: (st.season.counters[name] ?? 0) + by } } }));
            checkAch();
          },
        };
      },
      {
        name: SAVE_KEY,
        version: SAVE_VERSION,
        storage: createJSONStorage(options.storage ?? browserStorage),
        skipHydration: options.skipHydration ?? false,
        partialize: (st): PersistedGame => ({ profile: st.profile, settings: st.settings, season: st.season, session: st.session }),
        migrate: (persisted, version) => migrateSave(persisted, version),
        merge: (persisted, current) => ({ ...current, ...sanitizeSave((persisted ?? {}) as Record<string, unknown>) }),
      }
    )
  ) as GameStore;

  return store;
}
