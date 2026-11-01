"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CharacterDef } from "@/types/story";
import type { ObjectiveView } from "@/types/ui";
import { cn } from "@/lib/utils";
import { Glyph } from "@/components/kit/glyphs";
import { Redaction } from "@/components/kit/screen";
import { RichText } from "@/components/kit/rich-text";
import { lowerFirst, surnameAccusative, typo } from "@/components/kit/typo";

export interface ObjectiveListProps {
  objectives: ObjectiveView[];
  /** Персонажи — подсказки звучат их голосами */
  characters?: Record<string, CharacterDef>;
  /** Открыть следующий уровень подсказки */
  onRevealHint?: (objectiveId: string) => void;
  title?: string;
  /** Скрыть строку «Выполнено N из M» */
  hideHeader?: boolean;
  className?: string;
}

/**
 * Задания (раздел 7.9) — блокнот следователя: нумерованный чек-лист без коробок,
 * рамок и прогресс-баров. Текущее отмечено натриевым маркером, закрытое замаскировано.
 * Подсказки (раздел 7.10) — сообщения персонажей в материале экрана: отправитель, время, текст.
 */
export function ObjectiveList({
  objectives,
  characters = {},
  onRevealHint,
  title = "Задания",
  hideHeader = false,
  className,
}: ObjectiveListProps) {
  const main = objectives.filter((o) => !o.optional);
  const extra = objectives.filter((o) => o.optional);
  const done = main.filter((o) => o.state === "done").length;
  // Текущее — первое активное основное задание; остальные активные — «предстоящие открытые»
  const currentId = main.find((o) => o.state === "active")?.id;

  // Задания, выполненные на глазах игрока: их следствие печатается (голос Ноль)
  const prev = useRef<Map<string, ObjectiveView["state"]> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const before = prev.current;
    const now = new Map(objectives.map((o) => [o.id, o.state]));
    prev.current = now;
    if (!before) return;
    const changed = objectives.filter((o) => o.state === "done" && before.get(o.id) && before.get(o.id) !== "done");
    if (changed.length === 0) return;
    const t = window.setTimeout(() => setFresh((s) => new Set([...s, ...changed.map((o) => o.id)])), 0);
    return () => window.clearTimeout(t);
  }, [objectives]);

  const item = (o: ObjectiveView, number: number) => (
    <ObjectiveItem
      key={o.id}
      objective={o}
      number={number}
      current={o.id === currentId || (o.optional === true && o.state === "active")}
      quiet={o.optional === true}
      typeOutcome={fresh.has(o.id)}
      characters={characters}
      onRevealHint={onRevealHint}
    />
  );

  return (
    <section aria-label={title} className={cn("flex min-w-0 flex-col px-3 pt-3 pb-6", className)}>
      {!hideHeader && (
        <p className="mb-4 ui-12 text-ink-3">
          Выполнено <span className="tnum">{done}</span> из <span className="tnum">{main.length}</span>
        </p>
      )}

      <ol className="flex flex-col gap-4">{main.filter((o) => o.id === currentId).map((o) => item(o, main.indexOf(o) + 1))}</ol>
      {done > 0 && <details className="mt-4">
        <summary className="cursor-pointer py-2 ui-13 text-ink-2">Выполненные задания: {done}</summary>
        <ol className="mt-2 flex flex-col gap-4">{main.filter((o) => o.state === "done").map((o) => item(o, main.indexOf(o) + 1))}</ol>
      </details>}
      {main.some((o) => o.state === "locked") && <p className="mt-3 ui-12 text-ink-3">Следующее задание появится после текущего.</p>}

      {extra.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer py-2 ui-13 font-medium text-ink-2">Сверх плана: {extra.length}</summary>
          <ol className="flex flex-col gap-4">{extra.map((o, i) => item(o, main.length + i + 1))}</ol>
        </details>
      )}
    </section>
  );
}

/** «Соколова В. А.» — как отправитель в рабочем мессенджере */
export function officialName(c: CharacterDef): string {
  const parts = c.name.trim().split(/\s+/);
  const surname = parts[parts.length - 1];
  const given = parts.length > 1 ? parts[0] : "";
  const initials = [given, c.patronymic].filter(Boolean).map((w) => `${w![0]}.`).join("\u00A0");
  return initials ? `${surname} ${initials}` : surname;
}

/** Длины слов скрытого текста: «******* ** ********» */
function wordLengths(text: string): number[] {
  return text
    .replace(/`/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.length);
}

/**
 * Пункт: колонка состояния 12 px (маркер, галочка или пусто) и колонка номера 18 px —
 * номер есть у каждого пункта. Глифы выровнены по первой строке текста.
 */
function Gutter({ glyph, number, tone }: { glyph?: ReactNode; number: number; tone: string }) {
  return (
    <>
      <span className="flex h-[21px] items-center">{glyph}</span>
      <span className={cn("text-right mono-12 leading-[21px] tnum", tone)}>{number}</span>
    </>
  );
}

const ROW = "grid grid-cols-[12px_18px_minmax(0,1fr)] gap-x-2";

function ObjectiveItem({
  objective: o,
  number,
  current,
  quiet = false,
  typeOutcome,
  characters,
  onRevealHint,
}: {
  objective: ObjectiveView;
  number: number;
  current: boolean;
  /** Сверх плана: маркер без натрия — тёплое пятно на столе одно */
  quiet?: boolean;
  typeOutcome: boolean;
  characters: Record<string, CharacterDef>;
  onRevealHint?: (id: string) => void;
}) {
  const hints = o.hints ?? [];
  const revealed = Math.min(o.hintsRevealed ?? 0, hints.length);
  const nextHint = hints[revealed];
  const nextBy = nextHint?.speaker ? characters[nextHint.speaker] : undefined;
  const askLabel = nextBy
    ? `Спросить ${nextBy.shortNameAcc ?? surnameAccusative(nextBy.shortName)}`
    : "Запросить методическую помощь";
  const lastLevel = revealed + 1 === hints.length;
  const price =
    nextHint?.cost === undefined ? null : nextHint.cost === 0 ? "бесплатно" : `−${nextHint.cost} к\u00A0оценке`;

  if (o.state === "locked") {
    return (
      <li className={ROW} aria-label={`Задание ${number} закрыто`}>
        <Gutter number={number} tone="text-ink-3" />
        <Redaction chars={o.text.length} words={wordLengths(o.text)} className="mono-12 leading-[21px] break-words" />
      </li>
    );
  }

  if (o.state === "done") {
    return (
      <li className={ROW}>
        <Gutter glyph={<Glyph name="check" size={12} label="выполнено" className="text-ink-3" />} number={number} tone="text-ink-3" />
        <div className="min-w-0">
          <p className="ui-14 text-ink-3">
            <RichText text={o.text} />
          </p>
          {o.outcome && (
            <p className="mt-1 doc-14 text-ink-2 italic">
              <Typed text={typo(o.outcome)} active={typeOutcome} />
            </p>
          )}
        </div>
      </li>
    );
  }

  if (!current) {
    return (
      <li className={ROW}>
        <Gutter number={number} tone="text-ink-3" />
        <p className="min-w-0 ui-14 text-ink-2">
          <RichText text={o.text} />
        </p>
      </li>
    );
  }

  return (
    <li className={ROW} aria-current="step">
      <Gutter
        glyph={
          <span className={quiet ? "text-ink-3" : "text-sodium"}>
            <Glyph name="marker" size={10} />
            <span className="sr-only">текущее</span>
          </span>
        }
        number={number}
        tone="text-ink-1"
      />
      <div className="min-w-0">
        <p className="ui-14 text-ink-1">
          <RichText text={o.text} />
        </p>
        {o.detail && (
          <p className="mt-1 ui-13 text-ink-2">
            <RichText text={o.detail} />
          </p>
        )}
        {o.feedback && (
          <p className="mt-2 ui-13 text-ink-2" role="status">
            Не засчитано: <RichText text={lowerFirst(o.feedback)} />
          </p>
        )}

        {revealed > 0 && (
          <div className="mt-3 flex flex-col gap-3">
            {hints.slice(0, revealed).map((hint, i) => {
              const by = hint.speaker ? characters[hint.speaker] : undefined;
              return (
                <figure key={i} className="border-l border-line-strong pl-3">
                  <figcaption className="flex items-baseline gap-2 ui-12 text-ink-3">
                    <span>{by ? officialName(by) : "пометка на полях"}</span>
                    {hint.at && <span className="mono-12">{hint.at}</span>}
                  </figcaption>
                  <blockquote className="mt-0.5 ui-14 text-ink-1">
                    <RichText text={hint.text} />
                  </blockquote>
                </figure>
              );
            })}
          </div>
        )}

        {hints.length > 0 && onRevealHint && revealed < hints.length && (
          <div className="mt-3">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <button
                type="button"
                onClick={() => onRevealHint(o.id)}
                className="ui-13 text-ink-2 underline-offset-[3px] hover:text-ink-1 hover:underline max-lg:min-h-11"
              >
                {askLabel}
              </button>
              <span className="tnum ui-12 text-ink-3">
                {revealed + 1}&nbsp;из&nbsp;{hints.length}
                {price && <>, {price}</>}
              </span>
            </div>
            {lastLevel && <p className="mt-0.5 ui-12 text-ink-3">Задание будет отмечено «с&nbsp;подсказкой».</p>}
          </div>
        )}
      </div>
    </li>
  );
}

/** Следствие печатается по 18 мс на знак — это голос Ноль */
function Typed({ text, active }: { text: string; active: boolean }) {
  const [shown, setShown] = useState(active ? 0 : text.length);
  useEffect(() => {
    if (!active) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const t = window.setTimeout(() => setShown(text.length), 0);
      return () => window.clearTimeout(t);
    }
    let n = 0;
    const t = window.setInterval(() => {
      n += 1;
      setShown(n);
      if (n >= text.length) window.clearInterval(t);
    }, 18);
    return () => window.clearInterval(t);
  }, [active, text]);
  const visible = Math.min(shown, text.length);
  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden>{text.slice(0, visible)}</span>
      {visible < text.length && (
        <span aria-hidden className="invisible">
          {text.slice(visible)}
        </span>
      )}
    </>
  );
}
