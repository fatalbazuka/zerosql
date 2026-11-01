/**
 * Сохранение стора: localStorage через zustand persist, версия схемы и
 * миграции. Сохраняются профиль, настройки, сезон и активное дело (с журналом
 * ядра); база дела собирается из журнала при загрузке.
 */
import { DEFAULT_PROFILE, DEFAULT_SETTINGS, emptySeason } from "./rules";
import type { CaseSession, PersistedGame } from "./types";

export const SAVE_KEY = "zerosql.season.v2";
/** Версия схемы сохранения. Меняется — добавить шаг в MIGRATIONS */
export const SAVE_VERSION = 3;

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Шаги миграции: ключ — версия, ИЗ которой мигрируем.
 *  1 → 2: настройки typewriter / lieHighlight; у сезона появились mastery,
 *         counters и endingsSeen; у дела — closedAt и freeHintTokens.
 *  2 → 3: завершённые составные задания включают новые учебные подшаги.
 */
export const MIGRATIONS: Record<number, (state: Raw) => Raw> = {
  2: (s) => {
    if (!isObj(s.session) || !Array.isArray(s.session.completed)) return s;
    const session = s.session;
    const completed = [...session.completed as string[]];
    const add = (after: string, ids: string[]) => {
      if (completed.includes(after)) for (const id of ids) if (!completed.includes(id)) completed.push(id);
    };
    // Уже решённые составные задания включают новые промежуточные навыки.
    if (session.caseId === "case-00-nulevoy-etazh") add("p4", ["p3a", "p3b"]);
    if (session.caseId === "case-01-med") {
      add("o1_1", ["o1_start"]);
      add("o1_2", ["o1_night", "o1_windows"]);
    }
    return { ...s, session: { ...session, completed } };
  },
  1: (s) => {
    const settings = isObj(s.settings) ? s.settings : {};
    const season = isObj(s.season) ? s.season : {};
    const session = isObj(s.session) ? { closedAt: {}, freeHintTokens: 0, ...s.session } : null;
    return {
      ...s,
      settings: { typewriter: true, lieHighlight: false, ...settings },
      season: { mastery: {}, counters: {}, endingsSeen: [], ...season },
      session,
    };
  },
};

/** Приводит сохранение любой известной версии к текущей и заполняет пропуски значениями по умолчанию */
export function migrateSave(persisted: unknown, fromVersion: number): PersistedGame {
  let state: Raw = isObj(persisted) ? persisted : {};
  for (let v = Math.max(0, fromVersion); v < SAVE_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (step) state = step(state);
  }
  return sanitizeSave(state);
}

export function sanitizeSave(state: Raw): PersistedGame {
  const profile = isObj(state.profile) ? state.profile : {};
  const settings = isObj(state.settings) ? state.settings : {};
  const season = isObj(state.season) ? state.season : {};
  const session = isObj(state.session) && typeof state.session.caseId === "string" ? state.session : null;
  return {
    profile: { ...DEFAULT_PROFILE, ...profile } as PersistedGame["profile"],
    settings: { ...DEFAULT_SETTINGS, ...settings } as PersistedGame["settings"],
    season: { ...emptySeason(), ...season } as PersistedGame["season"],
    session: session as CaseSession | null,
  };
}

/** Память вместо localStorage (SSR, тесты, приватный режим) */
export function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

/** localStorage, если доступен; иначе память */
export function browserStorage(): Storage {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const probe = "__zerosql_probe__";
      window.localStorage.setItem(probe, "1");
      window.localStorage.removeItem(probe);
      return window.localStorage;
    }
  } catch {
    // приватный режим / запрет хранилища
  }
  return memoryStorage();
}
