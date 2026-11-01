"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { QueryResult } from "@/types/database";
import { cn } from "@/lib/utils";
import { Glyph } from "@/components/kit/glyphs";
import { ScreenButton, screenButtonClass } from "@/components/kit/screen";
import { countOf, formatInt, formatMs, lowerFirst, ruPlural } from "@/components/kit/typo";
import { errorToken, findToken } from "./sql-error-token";

/** Строка подвала о задании: «задание 3 выполнено» (ink-1) или «задание 3 не засчитано» (ink-3) */
export interface ResultObjectiveNote {
  text: string;
  tone?: "done" | "miss";
}

export interface ResultsGridProps {
  result: QueryResult | null;
  /** Приобщить строку к делу; без колбэка действие «приобщить» не показывается */
  onPinRow?: (rowIndex: number) => void;
  /** Уже приобщённые строки (индексы в result.rows) */
  pinnedRows?: number[];
  /** Сколько строк рисовать максимум */
  maxRows?: number;
  running?: boolean;
  /** Своё содержимое вместо приветствия до первого запроса */
  idleHint?: ReactNode;
  /** Строки приветствия до первого запроса, каждая с «> » */
  idleLines?: string[];
  /** Alt+клик по значению: вставить его литералом в редактор ('B-0233', 42, NULL) */
  onInsertValue?: (literal: string) => void;
  /** Клик по предложенному имени в ошибке: заменить ошибочное имя в редакторе */
  onSuggest?: (identifier: string, wrong?: string) => void;
  /** Что стало с текущим заданием после этого запроса — строкой в подвале рядом с числом строк */
  objectiveNote?: ResultObjectiveNote | null;
  /** Текст выполненного запроса: для «Ошибка в строке 2» */
  sql?: string;
  /** У дела есть квота: ошибки и отказы её не тратят, подвал говорит «квота не списана» */
  budgeted?: boolean;
  className?: string;
}

/**
 * Таблица результатов (раздел 7.7) и вывод ошибок (раздел 7.8).
 * Плотно: строка 24 px, PT Mono, линейки, без зебры и цвета. Ничего не анимируется,
 * кроме фирменного жеста — полёта приобщённой строки к «Материалам».
 * Широкий результат говорит, что справа есть ещё столбцы; выбранная ячейка показывает
 * значение целиком, в кавычках и с типом — пробелы, пустые строки и NULL видны.
 */
export function ResultsGrid({
  result,
  onPinRow,
  pinnedRows = [],
  maxRows = 500,
  running = false,
  idleHint,
  idleLines,
  onInsertValue,
  onSuggest,
  objectiveNote,
  sql,
  budgeted = false,
  className,
}: ResultsGridProps) {
  const slow = useSlowFlag(running, 150);
  const note = objectiveNote ? <ObjectiveNote note={objectiveNote} /> : null;

  return (
    <section
      aria-label="Результат запроса"
      aria-busy={running}
      data-desk-region="results"
      className={cn("flex min-h-0 min-w-0 flex-col bg-scr-base", className)}
    >
      {result === null ? (
        <>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {idleHint ?? <TerminalLines lines={idleLines ?? ["Зеркало подключено."]} />}
          </div>
          <Footer slow={slow} />
        </>
      ) : result.error ? (
        <>
          <ErrorOutput result={result} onSuggest={onSuggest} sql={sql} />
          <Footer
            slow={slow}
            fields={[
              result.errorKind === "locked_table" || result.errorKind === "read_only" ? "отказано" : "запрос не выполнен",
              ...(budgeted ? ["квота не списана"] : []),
            ]}
          />
        </>
      ) : (
        <DataTable
          result={result}
          maxRows={maxRows}
          onPinRow={onPinRow}
          pinnedRows={pinnedRows}
          onInsertValue={onInsertValue}
          slow={slow}
          note={note}
        />
      )}
    </section>
  );
}

function ObjectiveNote({ note }: { note: ResultObjectiveNote }) {
  return <span className={cn("truncate", note.tone === "miss" ? "text-ink-3" : "text-ink-1")}>{note.text}</span>;
}

/* ---------- «Выполняется…» — только если запрос идёт дольше 150 мс ---------- */

function useSlowFlag(running: boolean, delay: number): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!running) return;
    const t = window.setTimeout(() => setSlow(true), delay);
    return () => {
      window.clearTimeout(t);
      setSlow(false);
    };
  }, [running, delay]);
  return running && slow;
}

/* ---------- Касание без наведения: строка открывается листом снизу ---------- */

const TOUCH_QUERY = "(hover: none)";
function subscribeTouch(cb: () => void) {
  const mq = window.matchMedia(TOUCH_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
function useTouchOnly(): boolean {
  return useSyncExternalStore(
    subscribeTouch,
    () => window.matchMedia(TOUCH_QUERY).matches,
    () => false
  );
}

function TerminalLines({ lines }: { lines: string[] }) {
  return (
    <div className="mono-12 text-ink-3">
      {lines.map((line, i) => (
        <p key={i}>&gt; {line}</p>
      ))}
    </div>
  );
}

/* ---------- Значения ---------- */

function isNumericColumn(rows: unknown[][], col: number): boolean {
  let seen = false;
  for (const row of rows) {
    const v = row[col];
    if (v === null || v === undefined) continue;
    if (typeof v !== "number" && typeof v !== "bigint") return false;
    seen = true;
  }
  return seen;
}

/** Значение литералом SQL: строки в одинарных кавычках */
function toLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Тип значения словами SQLite — как в схеме слева */
function typeOf(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "bigint") return "integer";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "real";
  if (value instanceof Uint8Array) return "blob";
  return "text";
}

/**
 * Ячейка: пробелы сохраняются (white-space: pre), пробелы по краям подчёркнуты пунктиром,
 * пустая строка видна как '' — иначе ловушки «'Береговая '» и «''» не разглядеть.
 */
function CellValue({ value, expanded = false }: { value: unknown; expanded?: boolean }) {
  if (value === null || value === undefined) return <span className="text-ink-3">NULL</span>;
  if (value instanceof Uint8Array) return <span className="text-ink-3">BLOB, {value.byteLength} байт</span>;
  const text = String(value);
  if (text === "") return <span className="text-ink-3">&apos;&apos;</span>;
  const lead = text.match(/^\s+/)?.[0] ?? "";
  const trail = text.length > lead.length ? (text.match(/\s+$/)?.[0] ?? "") : "";
  const core = text.slice(lead.length, text.length - trail.length);
  const ws = "underline decoration-ink-3 decoration-dotted decoration-1 underline-offset-[4px]";
  const body = (
    <>
      {lead && <span className={ws}>{lead}</span>}
      {core}
      {trail && <span className={ws}>{trail}</span>}
    </>
  );
  return !expanded && text.length > 40 ? <span className="inline-block max-w-[40ch] truncate align-top">{body}</span> : body;
}

/** «street = 'Береговая '   text, 10 знаков» — значение целиком, как в панели значения */
function inspectorText(column: string, value: unknown): { value: string; meta: string } {
  if (value === null || value === undefined) return { value: `${column} = NULL`, meta: "" };
  const literal = toLiteral(value);
  const shown = literal.length > 96 ? `${literal.slice(0, 95)}…` : literal;
  const type = typeOf(value);
  if (type === "text") {
    const n = String(value).length;
    return { value: `${column} = ${shown}`, meta: `text, ${formatInt(n)} ${ruPlural(n, ["знак", "знака", "знаков"])}` };
  }
  return { value: `${column} = ${shown}`, meta: type };
}

/* ---------- Таблица ---------- */

type Cell = { r: number; c: number };

function DataTable({
  result,
  maxRows,
  onPinRow,
  pinnedRows,
  onInsertValue,
  slow,
  note,
}: {
  result: QueryResult;
  maxRows: number;
  onPinRow?: (rowIndex: number) => void;
  pinnedRows: number[];
  onInsertValue?: (literal: string) => void;
  slow: boolean;
  note: ReactNode;
}) {
  const rows = result.rows.slice(0, maxRows);
  const numeric = result.columns.map((_, i) => isNumericColumn(rows, i));
  const pinned = new Set(pinnedRows);
  const [sel, setSel] = useState<Cell | null>(null);
  const [sheet, setSheet] = useState<Cell | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cols = result.columns.length;
  const touch = useTouchOnly();

  // Новый результат — выделение сбрасывается (паттерн «состояние от пропса»)
  const [seenResult, setSeenResult] = useState(result);
  if (seenResult !== result) {
    setSeenResult(result);
    setSel(null);
    setSheet(null);
  }

  /* ----- Сколько столбцов скрыто справа ----- */
  const [hiddenRight, setHiddenRight] = useState(0);
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const edge = el.scrollLeft + el.clientWidth + 1;
    const heads = Array.from(el.querySelectorAll<HTMLElement>("thead th[data-col]"));
    setHiddenRight(heads.filter((th) => th.offsetLeft + th.offsetWidth > edge).length);
  }, []);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const table = el.querySelector("table");
    if (table) ro.observe(table);
    el.addEventListener("scroll", measure, { passive: true });
    document.fonts?.ready.then(measure).catch(() => undefined);
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, [measure, result]);

  const scrollToNextHidden = () => {
    const el = scrollRef.current;
    if (!el) return;
    const edge = el.scrollLeft + el.clientWidth + 1;
    const next = Array.from(el.querySelectorAll<HTMLElement>("thead th[data-col]")).find(
      (th) => th.offsetLeft + th.offsetWidth > edge
    );
    if (next) el.scrollLeft = Math.max(0, next.offsetLeft + next.offsetWidth - el.clientWidth + 40);
  };

  const rowEl = (r: number) => scrollRef.current?.querySelector<HTMLElement>(`tr[data-row="${r}"]`) ?? null;

  const pin = (r: number) => {
    if (!onPinRow || pinned.has(r)) return;
    const el = rowEl(r);
    if (el && scrollRef.current) flyToRegistry(el, scrollRef.current);
    onPinRow(r);
  };

  const onCellClick = (e: MouseEvent, r: number, c: number) => {
    if (e.altKey && onInsertValue) {
      e.preventDefault();
      onInsertValue(toLiteral(rows[r][c]));
      return;
    }
    setSel({ r, c });
    if (touch || window.matchMedia("(max-width: 1023px)").matches) setSheet({ r, c });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0) return;
    if (e.key === "Enter" && e.ctrlKey && e.shiftKey && sel) {
      e.preventDefault();
      pin(sel.r);
      return;
    }
    if (e.key === "Escape" && sel) {
      setSheet(null);
      setSel(null);
      return;
    }
    if (e.key === "Enter" && sel) {
      e.preventDefault();
      setSheet(sel);
      return;
    }
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    const cur = sel ?? { r: 0, c: 0 };
    const next = sel
      ? { r: Math.min(rows.length - 1, Math.max(0, cur.r + m[0])), c: Math.min(cols - 1, Math.max(0, cur.c + m[1])) }
      : cur;
    setSel(next);
    scrollRef.current
      ?.querySelector(`tr[data-row="${next.r}"] td[data-col="${next.c}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  const selValue = sel ? rows[sel.r]?.[sel.c] : undefined;
  const inspector = sel && sel.r < rows.length ? inspectorText(result.columns[sel.c], selValue) : null;

  return (
    <>
      <div
        ref={scrollRef}
        tabIndex={0}
        role="region"
        aria-label="Строки результата"
        data-results-focus
        onKeyDown={onKeyDown}
        className="zs-scroll-strong relative min-h-0 flex-1 overflow-auto focus-visible:outline-offset-[-1px] lg:overflow-x-scroll"
      >
        {/* Запрос без столбцов (INSERT, UPDATE, CREATE VIEW): шапки таблицы нет — только строка терминала */}
        {cols > 0 && (
          <table className="w-max min-w-full border-separate border-spacing-0 mono-13 text-ink-1">
            <thead>
              <tr>
                <th
                  scope="col"
                  className="sticky top-0 left-0 z-20 h-7 w-10 min-w-10 border-r border-b border-r-line border-b-line-strong bg-scr-chrome"
                >
                  <span className="sr-only">Номер строки</span>
                </th>
                {result.columns.map((col, i) => (
                  <th
                    key={`${col}-${i}`}
                    scope="col"
                    data-col={i}
                    className={cn(
                      // w-px: столбец по ширине содержимого, как в настоящих таблицах данных; остаток — пустой столбец справа
                      "sticky top-0 z-10 h-7 w-px border-b border-line-strong bg-scr-chrome px-3 mono-12 font-normal whitespace-nowrap text-ink-2",
                      // Разделитель между заголовками — как ручка изменения ширины
                      "after:pointer-events-none after:absolute after:top-[7px] after:right-0 after:h-3.5 after:w-px after:bg-line-strong",
                      numeric[i] ? "text-right" : "text-left"
                    )}
                  >
                    {col}
                  </th>
                ))}
                <th aria-hidden className="sticky top-0 z-10 h-7 border-b border-line-strong bg-scr-chrome" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => {
                const isPinned = pinned.has(r);
                const rowSelected = sel?.r === r;
                return (
                  <tr
                    key={r}
                    data-row={r}
                    aria-selected={rowSelected || undefined}
                    className={cn("group/row", isPinned ? "bg-sodium-wash" : "hover:bg-scr-raise")}
                  >
                    <td
                      className={cn(
                        "sticky left-0 z-[1] h-6 w-10 border-r border-b border-line pr-2 text-right align-middle mono-12 tnum max-lg:h-[22px]",
                        isPinned
                          ? "bg-sodium-wash text-sodium"
                          : rowSelected
                            ? "bg-scr-base text-ink-1 group-hover/row:bg-scr-raise"
                            : "bg-scr-base text-ink-3 group-hover/row:bg-scr-raise"
                      )}
                    >
                      {r + 1}
                    </td>
                    {row.map((cell, c) => {
                      const isNull = cell === null || cell === undefined;
                      const selected = sel?.r === r && sel.c === c;
                      const full = isNull ? "NULL" : String(cell);
                      return (
                        <td
                          key={c}
                          data-col={c}
                          onClick={(e) => onCellClick(e, r, c)}
                          title={full.length > 40 ? full : undefined}
                          className={cn(
                            "h-6 w-px border-b border-line px-3 align-middle whitespace-pre max-lg:h-[22px] max-lg:text-[12px] max-lg:leading-[22px]",
                            numeric[c] && !isNull ? "text-right" : "text-left",
                            selected && "outline outline-1 -outline-offset-1 outline-ink-2"
                          )}
                        >
                          <CellValue value={cell} />
                        </td>
                      );
                    })}
                    <td aria-hidden className="border-b border-line" />
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {rows.length === 0 && (
          <div className="p-3">
            <TerminalLines lines={["Запрос выполнен. Строк: 0."]} />
          </div>
        )}
      </div>

      {/* Панель значения: выбранная ячейка целиком, в кавычках и с типом; справа — приобщить строку */}
      {inspector && sel && !touch && (
        <div className="flex max-h-40 shrink-0 items-start gap-4 overflow-y-auto border-t border-line bg-scr-base px-3 py-2 mono-12 max-lg:hidden">
          <span className="min-w-0 break-words whitespace-pre-wrap text-ink-1">{inspector.value}</span>
          {inspector.meta && <span className="shrink-0 text-ink-3">{inspector.meta}</span>}
          {onPinRow &&
            (pinned.has(sel.r) ? (
              <span className="ml-auto shrink-0 ui-12 text-ink-3">строка {sel.r + 1} приобщена</span>
            ) : (
              <button
                type="button"
                tabIndex={-1}
                data-testid="pin-row"
                onClick={() => pin(sel.r)}
                className={cn(screenButtonClass("text"), "ml-auto shrink-0 ui-12")}
              >
                приобщить строку {sel.r + 1}
                <span className="text-ink-3">Ctrl+Shift+Enter</span>
              </button>
            ))}
        </div>
      )}

      <Footer
        slow={slow}
        fields={
          cols === 0
            ? ["Запрос выполнен.", formatMs(result.executionTimeMs)]
            : [
                countOf(result.rowCount, ["строка", "строки", "строк"]),
                countOf(cols, ["столбец", "столбца", "столбцов"]),
                formatMs(result.executionTimeMs),
              ]
        }
        note={note}
        right={
          <>
            {(rows.length < result.rowCount || result.truncated) && (
              <span className="text-ink-1">показаны первые {formatInt(rows.length)}</span>
            )}
            {hiddenRight > 0 && (
              <button type="button" tabIndex={-1} onClick={scrollToNextHidden} className="text-ink-1 hover:underline underline-offset-[3px]">
                {`ещё ${countOf(hiddenRight, ["столбец", "столбца", "столбцов"])} справа\u00A0→`}
              </button>
            )}
          </>
        }
      />

      {sheet && touch && rows[sheet.r] && (
        <RowSheet
          columns={result.columns}
          row={rows[sheet.r]}
          index={sheet.r}
          cell={sheet.c}
          pinned={pinned.has(sheet.r)}
          onPin={onPinRow ? () => pin(sheet.r) : undefined}
          onInsert={onInsertValue ? (literal) => onInsertValue(literal) : undefined}
          onClose={() => setSheet(null)}
        />
      )}
    </>
  );
}

/* ---------- Мобильный: строка листом снизу ---------- */

function RowSheet({
  columns,
  row,
  index,
  cell,
  pinned,
  onPin,
  onInsert,
  onClose,
}: {
  columns: string[];
  row: unknown[];
  index: number;
  cell: number;
  pinned: boolean;
  onPin?: () => void;
  onInsert?: (literal: string) => void;
  onClose: () => void;
}) {
  const literal = toLiteral(row[cell]);
  const shortLiteral = literal.length > 24 ? `${literal.slice(0, 23)}…` : literal;
  return (
    <div className="fixed inset-0 z-[80] flex flex-col justify-end" role="dialog" aria-label={`Строка ${index + 1}`}>
      <button type="button" aria-label="Закрыть" onClick={onClose} className="min-h-0 flex-1 cursor-default bg-room/70" />
      <div className="max-h-[72dvh] overflow-y-auto border-t border-line-strong bg-scr-chrome pb-[env(safe-area-inset-bottom)]">
        <header className="flex h-11 items-center border-b border-line pl-4">
          <h3 className="ui-13 font-medium text-ink-1">Строка {index + 1}</h3>
          <button type="button" onClick={onClose} aria-label="Закрыть" className="ml-auto grid size-11 place-items-center text-ink-3">
            <Glyph name="close" size={12} />
          </button>
        </header>
        <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 px-4 py-2 mono-13 leading-[22px]">
          {columns.map((col, c) => (
            <div key={`${col}-${c}`} className={cn("contents", c === cell && "[&>dd]:text-ink-1 [&>dt]:text-ink-2")}>
              <dt className="truncate text-ink-3">{col}</dt>
              <dd className="break-all whitespace-pre-wrap text-ink-1">
                <CellValue value={row[c]} expanded />
              </dd>
            </div>
          ))}
        </dl>
        <div className="flex items-center gap-4 border-t border-line px-4 py-2">
          {onPin &&
            (pinned ? (
              <span className="ui-13 text-ink-3">Строка приобщена</span>
            ) : (
              <ScreenButton
                variant="primary"
                touch
                onClick={() => {
                  onPin();
                  onClose();
                }}
              >
                Приобщить
              </ScreenButton>
            ))}
          {onInsert && (
            <button
              type="button"
              onClick={() => {
                onInsert(literal);
                onClose();
              }}
              className={cn(screenButtonClass("text", { touch: true }), "min-w-0 truncate")}
            >
              {`вставить ${shortLiteral} в\u00A0запрос`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- Фирменный жест: снимок строки летит по дуге к «Материалам» ---------- */

function flyToRegistry(row: HTMLElement, scroller: HTMLElement) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const scope = row.closest("[data-desk]") ?? document;
  const targets = Array.from(scope.querySelectorAll<HTMLElement>("[data-pin-target]"));
  const target = targets.find((el) => el.offsetParent !== null);
  if (!target) return;

  const box = scroller.getBoundingClientRect();
  const rr = row.getBoundingClientRect();
  const left = Math.max(rr.left, box.left);
  const width = Math.max(120, Math.min(rr.right, box.right) - left);
  const to = target.getBoundingClientRect();

  const ghost = document.createElement("div");
  ghost.setAttribute("aria-hidden", "true");
  ghost.textContent = Array.from(row.querySelectorAll("td[data-col]"))
    .map((td) => td.textContent ?? "")
    .join("   ");
  Object.assign(ghost.style, {
    position: "fixed",
    left: `${left}px`,
    top: `${rr.top}px`,
    width: `${width}px`,
    height: "24px",
    padding: "0 12px",
    background: "var(--sodium-wash)",
    color: "var(--ink-1)",
    font: "13px/24px var(--font-mono)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    pointerEvents: "none",
    zIndex: "90",
    transformOrigin: "50% 50%",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.append(ghost);

  const dx = to.left + to.width / 2 - (left + width / 2);
  const dy = to.top + to.height / 2 - (rr.top + 12);
  const anim = ghost.animate(
    [
      { transform: "translate(0, 0) scale(1)", opacity: 1 },
      { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 56}px) scale(0.62)`, opacity: 1, offset: 0.5 },
      { opacity: 1, offset: 0.7 },
      { transform: `translate(${dx}px, ${dy}px) scale(0.35)`, opacity: 0 },
    ],
    { duration: 420, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)", fill: "forwards" }
  );
  anim.onfinish = () => ghost.remove();
  anim.oncancel = () => ghost.remove();
}

/* ---------- Подвал ---------- */

function Footer({
  fields = [],
  note,
  right,
  slow,
}: {
  fields?: string[];
  note?: ReactNode;
  right?: ReactNode;
  slow: boolean;
}) {
  return (
    <footer className="flex min-h-6 shrink-0 items-center gap-x-4 border-t border-line bg-scr-base px-3 mono-12 whitespace-nowrap text-ink-3 max-lg:flex-wrap max-lg:py-[3px] lg:h-6 lg:overflow-hidden">
      {slow ? (
        <span>Выполняется…</span>
      ) : (
        fields.map((f, i) => (
          <span key={i} className={cn("tnum", i === 2 && "max-lg:hidden")}>
            {f}
          </span>
        ))
      )}
      {!slow && note}
      {!slow && right && <span className="ml-auto flex items-center gap-4">{right}</span>}
    </footer>
  );
}

/* ---------- Ошибки: вывод терминала, без карточек и иконок ---------- */

/** «…«full_name»…» → имя моноширинным; в предложении — кликабельно, с пунктиром */
function Annotated({
  text,
  onPick,
  wrong,
}: {
  text: string;
  onPick?: (identifier: string, wrong?: string) => void;
  wrong?: string;
}) {
  const parts = text.split(/«([^»]+)»/g);
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) return <span key={i}>{part}</span>;
        const ident = /^[\w.]+$/.test(part);
        if (!ident) return <span key={i}>«{part}»</span>;
        if (onPick) {
          return (
            <button
              key={i}
              type="button"
              onClick={() => onPick(part, wrong)}
              className="mono-13 text-ink-1 underline decoration-ink-3 decoration-dashed decoration-1 underline-offset-[3px] hover:decoration-ink-1"
            >
              {part}
            </button>
          );
        }
        return (
          <span key={i} className="mono-13">
            {part}
          </span>
        );
      })}
    </>
  );
}

/** Третья строка ошибки: куда смотреть, если имя или таблица не найдены */
function whereToLook(error: string): string | null {
  if (/no such column/i.test(error)) return "Имена столбцов есть в схеме слева. Клик по имени вставит его в запрос.";
  if (/no such table/i.test(error)) return "Открытые таблицы перечислены в схеме слева. Клик по имени вставит его в запрос.";
  if (/ambiguous column/i.test(error)) return "Псевдоним таблицы пишется перед столбцом через точку: «a.badge_id».";
  if (/incomplete input|unrecognized token/i.test(error)) return "Запрос оборван: проверьте кавычки, скобки и точку с запятой.";
  if (/syntax error/i.test(error)) return "Порядок частей запроса: SELECT, FROM, JOIN, WHERE, GROUP BY, ORDER BY, LIMIT.";
  return "Справочник SQL — вкладка «Справка» справа.";
}

function ErrorOutput({
  result,
  onSuggest,
  sql,
}: {
  result: QueryResult;
  onSuggest?: (identifier: string, wrong?: string) => void;
  sql?: string;
}) {
  const kind = result.errorKind ?? "sql";
  const help = result.errorHelp;

  if (kind === "locked_table") {
    const table = result.error?.match(/«([^»]+)»/)?.[1] ?? help?.explanation.match(/«([^»]+)»/)?.[1];
    return (
      <div role="alert" className="min-h-0 flex-1 overflow-auto p-3">
        <p className="max-w-[72ch] ui-14 text-ink-1">
          <span className="font-semibold text-alarm">ОТКАЗАНО.</span>{" "}
          {table ? (
            <>
              Таблица <span className="mono-13">{table}</span> засекречена.
            </>
          ) : (
            "Таблица засекречена."
          )}{" "}
          Допуск не выдан.
        </p>
      </div>
    );
  }

  if (kind === "read_only") {
    return (
      <div role="alert" className="min-h-0 flex-1 overflow-auto p-3">
        <p className="max-w-[72ch] ui-14 text-ink-1">
          <span className="font-semibold text-alarm">ОТКАЗАНО.</span> Зеркало только для чтения. Изменять
          данные нельзя.
        </p>
      </div>
    );
  }

  const wrong = help?.explanation.match(/«([\w.]+)»/)?.[1];
  // «Возможно, вы имели в виду FROM?» → «Возможно, «FROM»?»: имя набирается PT Mono и кликается
  const suggestion = help?.suggestion
    ?.replace(/^Возможно, вы имели в виду /, "Возможно, ")
    .replace(/^(Возможно, )([A-Za-z_][\w.]*)(\?)$/, "$1«$2»$3");
  const isGuess = Boolean(suggestion?.startsWith("Возможно"));
  const token = errorToken(result);
  const line = sql && token ? findToken(sql, token)?.line : undefined;
  const multiline = Boolean(sql && sql.trim().includes("\n"));
  const third = (!isGuess && suggestion) || (result.error ? whereToLook(result.error) : null);

  return (
    <div role="alert" className="min-h-0 flex-1 overflow-auto p-3">
      <div className="flex max-w-[72ch] flex-col gap-1">
        <p className="ui-14 text-ink-1">
          <span className="text-alarm">{line && multiline ? `Ошибка в строке ${line}:` : "Ошибка:"}</span>{" "}
          {help ? <Annotated text={lowerFirst(help.explanation)} /> : "запрос не выполнен."}
          {isGuess && suggestion && (
            <>
              {" "}
              <Annotated text={suggestion} onPick={onSuggest} wrong={wrong} />
            </>
          )}
        </p>
        {result.error && <p className="mono-12 break-words text-ink-3">sqlite: {result.error}</p>}
        {third && (
          <p className="ui-14 text-ink-2">
            <Annotated text={third} />
          </p>
        )}
      </div>
    </div>
  );
}
