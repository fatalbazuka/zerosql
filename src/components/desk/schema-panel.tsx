"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import type { ForeignKey, TableInfo } from "@/types/database";
import { cn } from "@/lib/utils";
import { Glyph } from "@/components/kit/glyphs";
import { HintTooltip } from "@/components/kit/hint-tooltip";
import { PanelHeader, Redaction } from "@/components/kit/screen";

export interface SchemaPanelProps {
  tables: TableInfo[];
  foreignKeys?: ForeignKey[];
  /** Открытые таблицы; null/undefined — открыты все */
  unlockedTables?: string[] | null;
  /** Вставка текста в редактор: имя таблицы, столбца или JOIN */
  onInsert?: (text: string) => void;
  /** Описания таблиц по-русски: «Журнал пропусков: кто, где и когда прошёл.» */
  tableNotes?: Record<string, string>;
  /** Только что открытые таблицы — подсветка, которая гаснет */
  newTables?: string[];
  /** Развёрнутые при старте */
  defaultExpanded?: string[];
  /** Показывать имена закрытых таблиц (по умолчанию — замаскированы звёздочками) */
  revealLockedNames?: boolean;
  className?: string;
}

/** Событие для стола: что вставлено из схемы (на мобильном стол пишет «вставлено: …») */
export const SCHEMA_INSERT_EVENT = "zerosql:schema-insert";

type Row =
  | { key: string; kind: "table"; table: TableInfo; level: 1 }
  | { key: string; kind: "column"; table: TableInfo; col: TableInfo["columns"][number]; level: 2 }
  | { key: string; kind: "locked"; table: TableInfo; level: 1 }
  | { key: string; kind: "relation"; fk: ForeignKey; level: 1 };

/**
 * Схема (раздел 7.5): тихая колонка --scr-side, строки 22 px (на мобильном 44), PT Mono.
 * Ключи пишутся текстом (pk, → staff), закрытое замаскировано и подписано «нет допуска».
 * Клавиатура как в дереве: ↑↓ — по строкам, → раскрыть, ← свернуть, Enter — вставить.
 */
export function SchemaPanel({
  tables,
  foreignKeys = [],
  unlockedTables = null,
  onInsert,
  tableNotes = {},
  newTables = [],
  defaultExpanded = [],
  revealLockedNames = false,
  className,
}: SchemaPanelProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(defaultExpanded));
  // Подсветка новой таблицы держится, пока игрок её не заметил (наведение или раскрытие)
  const [noticed, setNoticed] = useState<Set<string>>(() => new Set(defaultExpanded));
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [showLocked, setShowLocked] = useState(false);
  const treeRef = useRef<HTMLDivElement>(null);
  const isOpen = (name: string) => unlockedTables === null || unlockedTables.includes(name);

  const open = tables.filter((t) => isOpen(t.name));
  const locked = tables.filter((t) => !isOpen(t.name));
  const fkByColumn = new Map<string, ForeignKey>();
  for (const fk of foreignKeys) fkByColumn.set(`${fk.from}.${fk.fromColumn}`, fk);
  const relations = foreignKeys.filter((fk) => isOpen(fk.from) && isOpen(fk.to));

  /* ---------- Плоский список видимых строк — для стрелок ---------- */
  const rows: Row[] = [];
  for (const table of open) {
    rows.push({ key: `t:${table.name}`, kind: "table", table, level: 1 });
    if (expanded.has(table.name)) {
      for (const col of table.columns) rows.push({ key: `c:${table.name}.${col.name}`, kind: "column", table, col, level: 2 });
    }
  }
  if (showLocked) for (const table of locked) rows.push({ key: `l:${table.name}`, kind: "locked", table, level: 1 });
  for (const fk of relations) rows.push({ key: `r:${fk.from}.${fk.fromColumn}`, kind: "relation", fk, level: 1 });
  const activeKey = rows.some((r) => r.key === focusKey) ? focusKey : (rows[0]?.key ?? null);

  const notice = (name: string) => setNoticed((prev) => (prev.has(name) ? prev : new Set(prev).add(name)));
  const setOpen = (name: string, value: boolean) => {
    notice(name);
    setExpanded((prev) => {
      if (prev.has(name) === value) return prev;
      const next = new Set(prev);
      if (value) next.add(name);
      else next.delete(name);
      return next;
    });
  };
  const toggle = (name: string) => setOpen(name, !expanded.has(name));

  const insert = (text: string) => {
    if (!onInsert) return;
    onInsert(text);
    treeRef.current?.dispatchEvent(new CustomEvent(SCHEMA_INSERT_EVENT, { bubbles: true, detail: text }));
  };
  const joinOf = (fk: ForeignKey) => `JOIN ${fk.to} ON ${fk.from}.${fk.fromColumn} = ${fk.to}.${fk.toColumn}`;

  const focusRow = (key: string) => {
    setFocusKey(key);
    treeRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = rows.findIndex((r) => r.key === activeKey);
    const row = rows[i];
    if (!row) return;
    switch (e.key) {
      case "ArrowDown":
        if (rows[i + 1]) focusRow(rows[i + 1].key);
        break;
      case "ArrowUp":
        if (rows[i - 1]) focusRow(rows[i - 1].key);
        break;
      case "Home":
        focusRow(rows[0].key);
        break;
      case "End":
        focusRow(rows[rows.length - 1].key);
        break;
      case "ArrowRight":
        if (row.kind === "table") {
          if (!expanded.has(row.table.name)) setOpen(row.table.name, true);
          else if (rows[i + 1]?.kind === "column") focusRow(rows[i + 1].key);
        }
        break;
      case "ArrowLeft":
        if (row.kind === "table" && expanded.has(row.table.name)) setOpen(row.table.name, false);
        else if (row.kind === "column") focusRow(`t:${row.table.name}`);
        break;
      case "Enter":
      case " ":
        if (row.kind === "table") insert(row.table.name);
        else if (row.kind === "column") insert(row.col.name);
        else if (row.kind === "relation") insert(joinOf(row.fk));
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const item = (key: string) => ({
    "data-key": key,
    tabIndex: key === activeKey ? 0 : -1,
    onFocus: () => setFocusKey(key),
  });
  const rowBox = "flex h-[22px] items-center pr-3 max-lg:h-11";
  const focusRing =
    "outline-none [&:focus-visible>.zs-row]:outline [&:focus-visible>.zs-row]:outline-1 [&:focus-visible>.zs-row]:-outline-offset-1 [&:focus-visible>.zs-row]:outline-ink-1";

  return (
    <section aria-label="Схема" data-desk-region="schema" className={cn("flex min-h-0 min-w-0 flex-col bg-scr-side", className)}>
      <PanelHeader title="Схема">
        <span className="mono-12 text-ink-3">
          {open.length}&nbsp;из&nbsp;{tables.length}
        </span>
      </PanelHeader>

      <div ref={treeRef} className="min-h-0 flex-1 overflow-y-auto py-1" onKeyDown={onKeyDown}>
        <ul role="tree" aria-label="Таблицы">
          {open.map((table) => {
            const isExpanded = expanded.has(table.name);
            const isNew = newTables.includes(table.name);
            const key = `t:${table.name}`;
            return (
              <li key={key} role="treeitem" aria-level={1} aria-expanded={isExpanded} aria-selected={key === activeKey} {...item(key)} className={focusRing}>
                <div
                  onMouseEnter={isNew ? () => notice(table.name) : undefined}
                  className={cn(
                    "zs-row",
                    rowBox,
                    "hover:bg-scr-raise",
                    isNew && !noticed.has(table.name) && "bg-sodium-wash",
                    isNew && noticed.has(table.name) && "anim-wash [--wash-delay:0ms]"
                  )}
                >
                  <span
                    role="presentation"
                    onClick={() => toggle(table.name)}
                    title={isExpanded ? "Свернуть" : "Развернуть"}
                    className="grid h-full w-7 shrink-0 cursor-pointer place-items-center pl-1 text-ink-3 hover:text-ink-1 max-lg:w-10"
                  >
                    <Glyph name={isExpanded ? "disclosure-open" : "disclosure"} size={10} />
                  </span>
                  <span
                    onClick={() => (onInsert ? insert(table.name) : toggle(table.name))}
                    title={onInsert ? "Вставить в запрос" : undefined}
                    className="min-w-0 flex-1 cursor-pointer truncate mono-13 leading-[22px] text-ink-1"
                  >
                    {table.name}
                  </span>
                </div>

                {isExpanded && (
                  <div>
                    {tableNotes[table.name] && (
                      <p className="pr-3 pb-1 pl-7 ui-12 text-ink-3">{tableNotes[table.name]}</p>
                    )}
                    <ul role="group" aria-label={`Столбцы ${table.name}`} className="pb-1">
                      {table.columns.map((col) => {
                        const fk = fkByColumn.get(`${table.name}.${col.name}`);
                        const ckey = `c:${table.name}.${col.name}`;
                        return (
                          <li key={ckey} role="treeitem" aria-level={2} aria-selected={ckey === activeKey} {...item(ckey)} className={focusRing}>
                            <div className={cn("zs-row", rowBox, "pl-9 hover:bg-scr-raise")}>
                              <span
                                onClick={() => insert(col.name)}
                                title={onInsert ? "Вставить в запрос" : undefined}
                                className={cn("flex min-w-0 flex-1 items-baseline gap-1.5", onInsert && "cursor-pointer")}
                              >
                                <span className="truncate mono-13 leading-[22px] text-ink-2">{col.name}</span>
                                {col.pk && <span className="mono-11 text-ink-3">pk</span>}
                              </span>
                              {fk ? (
                                <span
                                  onClick={() => setOpen(fk.to, true)}
                                  title={`${fk.to}.${fk.toColumn}`}
                                  className="ml-2 shrink-0 cursor-pointer mono-11 text-ink-3 hover:text-ink-1"
                                >
                                  → {fk.to}
                                </span>
                              ) : (
                                <span className="ml-2 shrink-0 mono-11 text-ink-3">{col.type.toLowerCase() || "—"}</span>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </li>
            );
          })}

          {(showLocked ? locked : []).map((table) => {
            const key = `l:${table.name}`;
            return (
              <HintTooltip key={key} content="Засекречено. Допуск не выдан." side="right">
                <li
                  role="treeitem"
                  aria-level={1}
                  aria-selected={key === activeKey}
                  aria-disabled
                  aria-label={revealLockedNames ? `${table.name}: нет допуска` : "Засекреченная таблица: нет допуска"}
                  {...item(key)}
                  className={focusRing}
                >
                  <div className={cn("zs-row", rowBox, "cursor-default gap-2 pl-7")}>
                    {revealLockedNames ? (
                      <span className="min-w-0 flex-1 truncate mono-13 leading-[22px] text-ink-3">{table.name}</span>
                    ) : (
                      <Redaction chars={table.name.length} className="min-w-0 flex-1 truncate mono-13 leading-[22px]" />
                    )}
                    <span className="shrink-0 mono-11 text-ink-3">нет допуска</span>
                  </div>
                </li>
              </HintTooltip>
            );
          })}
        </ul>
        {locked.length > 0 && <button type="button" className="w-full px-3 py-3 text-left ui-12 text-ink-3 hover:text-ink-1" aria-expanded={showLocked} onClick={() => {
          setShowLocked(!showLocked);
          setFocusKey(null);
        }}>{showLocked ? "Скрыть закрытые разделы" : `Закрытые разделы: ${locked.length}`}</button>}

        {relations.length > 0 && (
          <div className="pt-4">
            <h3 className="px-3 pb-1 ui-13 font-medium text-ink-2">Связи</h3>
            <ul role="tree" aria-label="Связи">
              {relations.map((fk) => {
                const key = `r:${fk.from}.${fk.fromColumn}`;
                return (
                  <li key={key} role="treeitem" aria-level={1} aria-selected={key === activeKey} {...item(key)} className={focusRing}>
                    <div
                      onClick={() => insert(joinOf(fk))}
                      title={onInsert ? "Вставить JOIN по этой связи" : undefined}
                      className={cn(
                        "zs-row block min-h-[22px] py-[2px] pr-3 pl-6 -indent-3 mono-12 break-words text-ink-2 max-lg:py-3",
                        onInsert && "cursor-pointer hover:bg-scr-raise"
                      )}
                    >
                      {fk.from}.{fk.fromColumn} →{" "}
                      {fk.to}.{fk.toColumn}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
