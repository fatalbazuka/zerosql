"use client";

import { useEffect, useRef, useState } from "react";
import { achievements, secrets } from "@/data";
import { gameStore, useGame, type Bark } from "@/stores/game";
import type { StatusMessage } from "@/components/desk/desk-layout";
import { CHARACTERS } from "./views";

const SYSTEM = new Set(["mira", "system", "narrator"]);
const LINE_ID = /^[a-z]+\.[\w.-]+$/;
const isPerson = (b: Bark) => !SYSTEM.has(b.speaker) && Boolean(CHARACTERS[b.speaker]);
const isSilent = (b: Bark) => (b.kind === "system" && isPerson(b)) || LINE_ID.test(b.text);

/** Системные события идут в журнал по одному; личные — отдельно в мессенджер. */
export function useDeskMessages() {
  const barks = useGame((s) => s.barks);
  const toasts = useGame((s) => s.toasts);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [showing, setShowing] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!showing) return;
    const timer = window.setTimeout(() => setShowing(false), 6000);
    return () => window.clearTimeout(timer);
  }, [showing]);

  useEffect(() => {
    if (showing) return;
    const bark = barks.find((b) => !isPerson(b) || isSilent(b));
    const toast = toasts[0];
    if (!bark && !toast) return;
    const timer = window.setTimeout(() => {
      const act = gameStore.getState();
      if (bark && (!toast || bark.id < toast.id)) {
        if (!isSilent(bark)) {
          setStatus({ id: `b${bark.id}`, text: bark.text });
          setShowing(true);
        }
        act.dismissBark(bark.id);
      } else if (toast) {
        const title = (toast.kind === "secret" ? secrets : achievements).find((x) => x.id === toast.refId)?.title;
        const what = toast.kind === "secret" ? "Найден тайник" : "Отметка в личном деле";
        setStatus({ id: `t${toast.id}`, text: title ? `${what}: «${title}».` : `${what}.` });
        setShowing(true);
        act.dismissToast(toast.id);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [barks, toasts, showing]);

  return {
    status,
    say: (text: string) => setStatus({ id: `l${++seq.current}`, text }),
    people: barks.filter((b) => isPerson(b) && !isSilent(b)),
  };
}

/** Подсказка предлагается после простоя на столе, а не во время чтения и прокрутки. */
export function useIdleHint(enabled: boolean, objectiveId: string | undefined) {
  useEffect(() => {
    if (!enabled || !objectiveId) return;
    let timer: number | undefined;
    const reset = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      if (!document.hidden) timer = window.setTimeout(() => gameStore.getState().offerHint(), 120_000);
    };
    const events = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const;
    events.forEach((event) => window.addEventListener(event, reset, { passive: true, capture: true }));
    document.addEventListener("visibilitychange", reset);
    reset();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      events.forEach((event) => window.removeEventListener(event, reset, true));
      document.removeEventListener("visibilitychange", reset);
    };
  }, [enabled, objectiveId]);
}
