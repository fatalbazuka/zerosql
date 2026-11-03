"use client";

/**
 * Стор v2 для экранов: синглтон gameStore, хук useGame(selector) и
 * useGameView(view) для производных данных (selectors.ts).
 *
 *   const phase = useGame((s) => s.session?.phase);
 *   const run = useGame((s) => s.runQuery);
 *   const objectives = useGameView(objectivesView);
 *
 * boot() вызывать один раз из корневого клиентского компонента (useEffect):
 * он поднимает сохранение из localStorage (без рассинхрона SSR) и ядро.
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { createGameStore, type GameState, type GameStore } from "./store";
import { watchSfx } from "./sfx";
import { getSaveStatus, subscribeSaveStatus } from "./persist";

export const gameStore = createGameStore({ skipHydration: true });

export function useGame<T>(selector: (state: GameState) => T): T {
  return useStore(gameStore, selector);
}

/** Производные данные: пересчитываются, когда меняются сохраняемые срезы или последний результат */
export function useGameView<T>(view: (state: GameState) => T): T {
  const session = useGame((s) => s.session);
  const season = useGame((s) => s.season);
  const profile = useGame((s) => s.profile);
  const settings = useGame((s) => s.settings);
  const last = useGame((s) => s.last);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => view(gameStore.getState()), [view, session, season, profile, settings, last]);
}

/** Сохранение поднято из localStorage (до этого стор держит значения по умолчанию) */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const persist = gameStore.persist as GameStore["persist"] & { onFinishHydration?: (fn: () => void) => () => void };
      const offState = gameStore.subscribe(cb);
      const offHydration = persist.onFinishHydration?.(cb);
      return () => {
        offState();
        offHydration?.();
      };
    },
    () => gameStore.persist.hasHydrated(),
    () => false
  );
}

/** Звуковая шина стола: подключить один раз в корневом клиентском компоненте */
export function useSfxBus(): void {
  useEffect(() => watchSfx(gameStore), []);
}

/** Доступность постоянного сохранения может измениться при ошибке записи. */
export function useSaveStatus() {
  return useSyncExternalStore(subscribeSaveStatus, getSaveStatus, () => "unknown" as const);
}

export { playSfx, SFX_MIX, type SfxName, type SfxCategory } from "./sfx";
export { createGameStore, seasonPoints, isCaseUnlocked, casePlayable } from "./store";
export type { GameState, GameActions, GameStore, GameStoreOptions, OfferInput } from "./store";
export * from "./selectors";
export { computeEnding, endingInputs, ENDING_TITLES } from "./endings";
export { WEATHER_LABELS, DEFAULT_SETTINGS, PIN_ALL_LIMIT } from "./rules";
export { SAVE_KEY, SAVE_VERSION, migrateSave } from "./persist";
export type * from "./types";
