import type { Database } from "sql.js";
import type { QueryResult } from "@/types/database";
import type { ValidationRule, ValidationOutcome, CellValue } from "@/types/mission";
import type { BlankKind, DatetimePrecision, ValidationContext } from "@/types/case";
import { executeQuery } from "./database";
import { normalizeCell, cellsEqual, valuesMatch } from "./values";
import { cardMatches, isSourceCard } from "./board";

// Нормализация живёт в values.ts; реэкспорт — для прежних импортов из validator
export { normalizeCell, cellsEqual } from "./values";
export type { ValidationContext } from "@/types/case";

function normalizeRows(rows: unknown[][]): string[][] {
  return rows
    .map((row) => row.map(normalizeCell))
    .sort((a, b) => a.join("|").localeCompare(b.join("|")));
}

function findColumns(result: QueryResult, names: string[] | undefined): number[] {
  if (!names?.length) return [];
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const found: number[] = [];
  result.columns.forEach((c, i) => {
    if (wanted.has(c.toLowerCase())) found.push(i);
  });
  return found;
}

function sortedNormalized(values: unknown[]): string[] {
  return values.map(normalizeCell).sort();
}

function sameSequence(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function compareColumn(
  actual: unknown[],
  expected: unknown[],
  mode: "equal" | "superset" | "subset",
  ordered: boolean
): boolean {
  if (ordered) {
    return sameSequence(actual.map(normalizeCell), expected.map(normalizeCell));
  }
  const a = new Set(actual.map(normalizeCell));
  const e = new Set(expected.map(normalizeCell));
  if (mode === "superset") return [...e].every((v) => a.has(v));
  if (mode === "subset") return a.size > 0 && [...a].every((v) => e.has(v));
  return a.size === e.size && [...e].every((v) => a.has(v));
}

function referenceError(): ValidationOutcome {
  return { passed: false, inconclusive: true, message: "Ошибка или слишком много строк в эталонном запросе. Сообщите разработчику." };
}

function incompleteResult(): ValidationOutcome {
  return { passed: false, inconclusive: true, message: "Результат слишком большой для полной проверки. Уточните запрос с помощью WHERE или LIMIT." };
}

function matchOptions(rule: { tolerance?: number; precision?: DatetimePrecision }) {
  return {
    ...(rule.tolerance !== undefined ? { tolerance: rule.tolerance } : {}),
    ...(rule.precision !== undefined ? { precision: rule.precision } : {}),
  };
}

/** Есть ли среди значений совпадающее с ожидаемым по правилам типа пропуска */
function someMatches(
  kind: BlankKind,
  expected: CellValue,
  values: Iterable<string>,
  rule: { tolerance?: number; precision?: DatetimePrecision }
): boolean {
  if (kind === "text" || kind === "person") {
    const key = normalizeCell(expected);
    for (const v of values) if (normalizeCell(v) === key) return true;
    return false;
  }
  const options = matchOptions(rule);
  for (const v of values) if (valuesMatch(kind, expected, v, options)) return true;
  return false;
}

/** Существует ли представление (в main или temp) */
function viewExists(db: Database, name: string): boolean {
  const sql =
    "SELECT 1 FROM sqlite_master WHERE type = 'view' AND lower(name) = lower(?) " +
    "UNION ALL SELECT 1 FROM sqlite_temp_master WHERE type = 'view' AND lower(name) = lower(?) LIMIT 1";
  const stmt = db.prepare(sql);
  try {
    stmt.bind([name, name]);
    return stmt.step();
  } finally {
    stmt.free();
  }
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Проверяет результат запроса правилом. ctx — состояние стола для правил
 * pin / seen / slot (без него они не проходят); остальным правилам не нужен.
 */
export function validate(
  rule: ValidationRule,
  result: QueryResult,
  db: Database,
  ctx: ValidationContext = {}
): ValidationOutcome {
  if (result.error) {
    return { passed: false, message: "Запрос вернул ошибку. Проверьте синтаксис." };
  }

  // Эти правила зависят от всего набора строк, а не только от первых 5000.
  if (result.truncated && ["row_count", "exact_match", "column_values", "rows_match", "custom"].includes(rule.type)) {
    return incompleteResult();
  }

  switch (rule.type) {
    case "row_count": {
      const { expected, comparison } = rule;
      const actual = result.rowCount;
      const passed =
        comparison === "eq"
          ? actual === expected
          : comparison === "gte"
            ? actual >= expected
            : actual <= expected;
      return {
        passed,
        message: passed
          ? "Количество записей совпадает. Отличная работа, детектив."
          : `Ожидалось ${comparison === "eq" ? "" : comparison === "gte" ? "не менее " : "не более "}${expected} записей, получено ${actual}.`,
      };
    }

    case "contains_columns": {
      const resultCols = result.columns.map((c) => c.toLowerCase());
      const missing = rule.columns.filter(
        (c) => !resultCols.includes(c.toLowerCase())
      );
      return {
        passed: missing.length === 0,
        message:
          missing.length === 0
            ? "Все нужные столбцы на месте."
            : `Не хватает столбцов: ${missing.join(", ")}`,
      };
    }

    case "contains_value": {
      const colIdx = result.columns.findIndex(
        (c) => c.toLowerCase() === rule.column.toLowerCase()
      );
      if (colIdx === -1) {
        return {
          passed: false,
          message: `Столбец «${rule.column}» не найден в результатах.`,
        };
      }
      const found = result.rows.some(
        (row) =>
          String(row[colIdx]).toLowerCase() ===
          String(rule.value).toLowerCase()
      );
      if (!found && result.truncated) return incompleteResult();
      return {
        passed: found,
        message: found
          ? "Нужное значение найдено. Вы на верном пути."
          : `Значение «${rule.value}» не найдено в столбце «${rule.column}».`,
      };
    }

    case "exact_match": {
      const ref = executeQuery(db, rule.referenceQuery);
      if (ref.error || ref.truncated) return referenceError();
      const refNorm = normalizeRows(ref.rows);
      const resNorm = normalizeRows(result.rows);
      const passed =
        JSON.stringify(refNorm) === JSON.stringify(resNorm) &&
        ref.columns.length === result.columns.length;
      return {
        passed,
        message: passed
          ? "Результат совпадает с эталоном. Блестящая работа."
          : "Результат не совпадает. Попробуйте другой подход.",
      };
    }

    case "requires_column": {
      const found = result.columns.some(
        (c) => c.toLowerCase() === rule.column.toLowerCase()
      );
      if (!found) {
        return {
          passed: false,
          message: `Столбец «${rule.column}» не найден в результатах.`,
        };
      }
      if (rule.minRows !== undefined && result.rowCount < rule.minRows) {
        if (result.truncated) return incompleteResult();
        return {
          passed: false,
          message: `Ожидалось не менее ${rule.minRows} записей, получено ${result.rowCount}.`,
        };
      }
      return {
        passed: true,
        message: `Столбец «${rule.column}» найден.`,
      };
    }

    case "contains_substring": {
      const colIdx = result.columns.findIndex(
        (c) => c.toLowerCase() === rule.column.toLowerCase()
      );
      if (colIdx === -1) {
        return {
          passed: false,
          message: `Столбец «${rule.column}» не найден в результатах.`,
        };
      }
      const found = result.rows.some((row) =>
        String(row[colIdx]).toLowerCase().includes(rule.substring.toLowerCase())
      );
      if (!found && result.truncated) return incompleteResult();
      return {
        passed: found,
        message: found
          ? `Подстрока «${rule.substring}» найдена в столбце «${rule.column}».`
          : `Значение «${rule.substring}» не найдено в столбце «${rule.column}».`,
      };
    }

    case "value_check": {
      if (rule.row >= result.rowCount) {
        if (result.truncated) return incompleteResult();
        return { passed: false, message: "Недостаточно строк в результате." };
      }
      const val = Number(result.rows[rule.row]?.[rule.col]);
      if (isNaN(val)) {
        return { passed: false, message: "Значение не является числом." };
      }
      const passed =
        rule.comparison === "eq" ? val === rule.expected
        : rule.comparison === "gt" ? val > rule.expected
        : rule.comparison === "gte" ? val >= rule.expected
        : rule.comparison === "lt" ? val < rule.expected
        : val <= rule.expected;
      return {
        passed,
        message: passed
          ? "Числовое значение совпадает."
          : `Ожидалось ${rule.comparison === "eq" ? "" : rule.comparison === "gt" ? "> " : rule.comparison === "gte" ? ">= " : rule.comparison === "lt" ? "< " : "<= "}${rule.expected}, получено ${val}.`,
      };
    }

    case "compound": {
      for (const subRule of rule.rules) {
        const sub = validate(subRule, result, db, ctx);
        if (!sub.passed) {
          return sub;
        }
      }
      return { passed: true, message: rule.successMessage };
    }

    case "any_of": {
      let lastFailMessage = "";
      let uncertain: ValidationOutcome | undefined;
      for (const subRule of rule.rules) {
        const sub = validate(subRule, result, db, ctx);
        if (sub.passed) {
          return { passed: true, message: rule.successMessage };
        }
        if (sub.inconclusive) uncertain = sub;
        lastFailMessage = sub.message;
      }
      return uncertain ?? { passed: false, message: lastFailMessage };
    }

    case "custom": {
      return rule.check(result);
    }

    case "cell_value": {
      const named = findColumns(result, rule.columns);
      if (rule.columns?.length && named.length === 0) {
        return {
          passed: false,
          message: `Нужен столбец ${rule.columns.map((c) => `«${c}»`).join(" или ")}.`,
        };
      }
      const indexes = named.length ? named : result.columns.map((_, i) => i);
      const found = result.rows.some((row) =>
        indexes.some((i) => cellsEqual(row[i], rule.value, rule.tolerance))
      );
      if (!found && result.truncated) return incompleteResult();
      return {
        passed: found,
        message: found ? "Нужное значение найдено." : "Нужного значения в результате нет.",
      };
    }

    case "column_values": {
      let expected: unknown[];
      if (rule.values) {
        expected = rule.values;
      } else if (rule.referenceQuery) {
        const ref = executeQuery(db, rule.referenceQuery);
        if (ref.error || ref.truncated) return referenceError();
        expected = ref.rows.map((r) => r[0]);
      } else {
        return referenceError();
      }

      const mode = rule.mode ?? "equal";
      const ordered = rule.ordered ?? false;
      const named = findColumns(result, rule.columns);
      const candidates = named.length ? named : result.columns.map((_, i) => i);

      for (const idx of candidates) {
        const actual = result.rows.map((r) => r[idx]);
        if (compareColumn(actual, expected, mode, ordered)) {
          return { passed: true, message: "Значения совпадают." };
        }
      }

      if (result.rowCount === 0) {
        return { passed: false, message: "Запрос не вернул ни одной строки." };
      }
      const probe = named[0];
      if (probe !== undefined) {
        const actual = result.rows.map((r) => r[probe]);
        if (ordered && compareColumn(actual, expected, "equal", false)) {
          return { passed: false, message: "Значения верные, но порядок строк не тот." };
        }
        const a = new Set(actual.map(normalizeCell));
        const e = new Set(expected.map(normalizeCell));
        const missing = [...e].filter((v) => !a.has(v)).length;
        const extra = [...a].filter((v) => !e.has(v)).length;
        const parts: string[] = [];
        if (missing && mode !== "subset") parts.push(`не хватает значений: ${missing}`);
        if (extra && mode !== "superset") parts.push(`лишних значений: ${extra}`);
        if (parts.length) {
          return { passed: false, message: `Не совпадает: ${parts.join(", ")}.` };
        }
      }
      return { passed: false, message: "Значения в результате не те, что нужны." };
    }

    case "rows_match": {
      const ref = executeQuery(db, rule.referenceQuery);
      if (ref.error || ref.truncated) return referenceError();
      if (result.rowCount !== ref.rowCount) {
        return {
          passed: false,
          message:
            result.rowCount > ref.rowCount
              ? "Строк больше, чем нужно. Возможно, не хватает фильтра или DISTINCT."
              : "Строк меньше, чем нужно. Возможно, фильтр слишком строгий.",
        };
      }

      const used = new Set<number>();
      const mapping: number[] = [];
      for (let j = 0; j < ref.columns.length; j++) {
        const name = ref.columns[j].toLowerCase();
        const names = [name, ...(rule.aliases?.[name] ?? []).map((a) => a.toLowerCase())];
        let idx = result.columns.findIndex((c, i) => !used.has(i) && names.includes(c.toLowerCase()));
        if (idx === -1) {
          const refValues = sortedNormalized(ref.rows.map((r) => r[j]));
          idx = result.columns.findIndex(
            (_, i) => !used.has(i) && sameSequence(sortedNormalized(result.rows.map((r) => r[i])), refValues)
          );
        }
        if (idx === -1) {
          return {
            passed: false,
            message: /^[\p{L}_][\p{L}\p{N}_]*$/u.test(name)
              ? `Не хватает столбца «${ref.columns[j]}» (или его значения не совпадают).`
              : "Не хватает столбца с нужными значениями.",
          };
        }
        used.add(idx);
        mapping.push(idx);
      }

      const project = (rows: unknown[][], cols: number[]) =>
        rows.map((r) => cols.map((c) => normalizeCell(r[c])).join("\u241F"));
      const mine = project(result.rows, mapping);
      const theirs = project(ref.rows, ref.columns.map((_, j) => j));
      const passed = rule.ordered
        ? sameSequence(mine, theirs)
        : sameSequence([...mine].sort(), [...theirs].sort());
      if (passed) return { passed: true, message: "Результат совпадает с ожидаемым." };
      if (rule.ordered && sameSequence([...mine].sort(), [...theirs].sort())) {
        return { passed: false, message: "Строки верные, но порядок не тот. Проверьте ORDER BY." };
      }
      return { passed: false, message: "Строки не совпадают с ожидаемыми." };
    }

    case "not": {
      const sub = validate(rule.rule, result, db, ctx);
      if (sub.inconclusive) return sub;
      return sub.passed
        ? { passed: false, message: rule.message }
        : { passed: true, message: "Проверка пройдена." };
    }

    case "table_state": {
      const state = executeQuery(db, rule.query);
      if (state.error) return referenceError();
      const sub = validate(rule.rule, state, db, ctx);
      if (sub.inconclusive) return sub;
      return sub.passed
        ? { passed: true, message: "Состояние базы — как нужно." }
        : { passed: false, message: "Данные в базе пока не в нужном состоянии." };
    }

    case "view_match": {
      if (!viewExists(db, rule.view)) {
        return { passed: false, message: `Представления «${rule.view}» нет. Создайте его: CREATE VIEW ${rule.view} AS …` };
      }
      const view = executeQuery(db, `SELECT * FROM ${quoteIdent(rule.view)}`);
      if (view.error) return { passed: false, message: `Представление «${rule.view}» не читается: ${view.error}` };
      if (rule.referenceQuery) {
        const rows = validate({ type: "rows_match", referenceQuery: rule.referenceQuery, ordered: rule.ordered }, view, db, ctx);
        if (!rows.passed) return { ...rows, message: `В представлении «${rule.view}»: ${lowerFirst(rows.message)}` };
      }
      if (rule.rule) {
        const sub = validate(rule.rule, view, db, ctx);
        if (!sub.passed) return { ...sub, message: `В представлении «${rule.view}»: ${lowerFirst(sub.message)}` };
      }
      return { passed: true, message: `Представление «${rule.view}» собрано верно.` };
    }

    case "pin": {
      const cards = (ctx.pins ?? []).filter((c) => (rule.includeGhosts || isSourceCard(c)) && cardMatches(c, rule.where));
      const need = Math.max(1, Math.floor(rule.min ?? 1));
      if (cards.length < need) {
        return { passed: false, message: rule.message ?? `Нужных карточек на доске: ${cards.length} из ${need}.` };
      }
      if (rule.sources !== undefined) {
        const classes = new Set(cards.map((c) => c.sourceClass).filter((s) => s !== undefined));
        if (classes.size < rule.sources) {
          return {
            passed: false,
            message: rule.message ?? `Независимых источников: ${classes.size} из ${rule.sources}.`,
          };
        }
      }
      return { passed: true, message: "Карточки на доске." };
    }

    case "seen": {
      const seen = ctx.seen;
      const found = !!seen && someMatches(rule.kind ?? "text", rule.value, seen, rule);
      return found
        ? { passed: true, message: "Значение уже встречалось в результатах." }
        : { passed: false, message: rule.message ?? "Это значение ещё не встречалось в результатах." };
    }

    case "slot": {
      const filled = ctx.slots?.[rule.slot];
      if (filled === undefined || filled.trim() === "") {
        return { passed: false, message: rule.message ?? "Слот не заполнен." };
      }
      const expected = Array.isArray(rule.value) ? rule.value : [rule.value];
      const ok = expected.some((v) => someMatches(rule.kind ?? "text", v, [filled], rule));
      return ok
        ? { passed: true, message: "Слот заполнен верно." }
        : { passed: false, message: rule.message ?? "В слоте не то значение." };
    }
  }
}

function lowerFirst(text: string): string {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}
