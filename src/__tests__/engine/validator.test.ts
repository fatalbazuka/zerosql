import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Database } from "sql.js";
import { setupTestDb } from "../helpers/setup-db";
import { validate } from "@/engine/validator";
import type { QueryResult } from "@/types/database";
import type { ValidationRule } from "@/types/mission";

let db: Database;

beforeEach(async () => {
  db = await setupTestDb();
});

afterEach(() => {
  db.close();
});

function makeResult(overrides: Partial<QueryResult> = {}): QueryResult {
  return {
    columns: ["id", "name"],
    rows: [[1, "test"]],
    rowCount: 1,
    executionTimeMs: 0.1,
    error: null,
    ...overrides,
  };
}

// ─── row_count ───────────────────────────────────────────

describe("row_count", () => {
  const rule = (expected: number, comparison: "eq" | "gte" | "lte"): ValidationRule => ({
    type: "row_count",
    expected,
    comparison,
  });

  it("eq: pass при точном совпадении", () => {
    const r = validate(rule(3, "eq"), makeResult({ rowCount: 3 }), db);
    expect(r.passed).toBe(true);
  });

  it("eq: fail при несовпадении", () => {
    const r = validate(rule(3, "eq"), makeResult({ rowCount: 5 }), db);
    expect(r.passed).toBe(false);
  });

  it("gte: pass при >=", () => {
    expect(validate(rule(3, "gte"), makeResult({ rowCount: 3 }), db).passed).toBe(true);
    expect(validate(rule(3, "gte"), makeResult({ rowCount: 5 }), db).passed).toBe(true);
  });

  it("gte: fail при <", () => {
    expect(validate(rule(3, "gte"), makeResult({ rowCount: 2 }), db).passed).toBe(false);
  });

  it("lte: pass при <=", () => {
    expect(validate(rule(3, "lte"), makeResult({ rowCount: 3 }), db).passed).toBe(true);
    expect(validate(rule(3, "lte"), makeResult({ rowCount: 1 }), db).passed).toBe(true);
  });

  it("lte: fail при >", () => {
    expect(validate(rule(3, "lte"), makeResult({ rowCount: 5 }), db).passed).toBe(false);
  });
});

// ─── error guard ─────────────────────────────────────────

describe("error guard", () => {
  it("result с error → всегда fail", () => {
    const errResult = makeResult({ error: "syntax error" });
    const r = validate({ type: "row_count", expected: 1, comparison: "eq" }, errResult, db);
    expect(r.passed).toBe(false);
    expect(r.message).toContain("ошибку");
  });
});

// ─── contains_columns ────────────────────────────────────

describe("contains_columns", () => {
  const rule = (columns: string[]): ValidationRule => ({
    type: "contains_columns",
    columns,
  });

  it("pass: все столбцы найдены", () => {
    const r = validate(rule(["id", "name"]), makeResult({ columns: ["id", "name", "alias"] }), db);
    expect(r.passed).toBe(true);
  });

  it("pass: case-insensitive", () => {
    const r = validate(rule(["ID", "Name"]), makeResult({ columns: ["id", "name"] }), db);
    expect(r.passed).toBe(true);
  });

  it("fail: отсутствующие столбцы", () => {
    const r = validate(rule(["id", "phone"]), makeResult({ columns: ["id", "name"] }), db);
    expect(r.passed).toBe(false);
    expect(r.message).toContain("phone");
  });
});

// ─── contains_value ──────────────────────────────────────

describe("contains_value", () => {
  const rule = (column: string, value: unknown): ValidationRule => ({
    type: "contains_value",
    column,
    value,
  });

  it("pass: значение найдено", () => {
    const r = validate(
      rule("name", "test"),
      makeResult({ columns: ["id", "name"], rows: [[1, "test"]] }),
      db
    );
    expect(r.passed).toBe(true);
  });

  it("pass: case-insensitive", () => {
    const r = validate(
      rule("name", "TEST"),
      makeResult({ columns: ["id", "name"], rows: [[1, "test"]] }),
      db
    );
    expect(r.passed).toBe(true);
  });

  it("fail: значение не найдено", () => {
    const r = validate(
      rule("name", "missing"),
      makeResult({ columns: ["id", "name"], rows: [[1, "test"]] }),
      db
    );
    expect(r.passed).toBe(false);
  });

  it("fail: столбец не найден", () => {
    const r = validate(
      rule("phone", "123"),
      makeResult({ columns: ["id", "name"], rows: [[1, "test"]] }),
      db
    );
    expect(r.passed).toBe(false);
    expect(r.message).toContain("phone");
  });
});

// ─── exact_match ─────────────────────────────────────────

describe("exact_match", () => {
  it("pass: одинаковые данные в другом порядке строк", () => {
    // Reference: SELECT * FROM suspects WHERE status = 'в розыске' returns 3 rows
    const ref = db.exec("SELECT * FROM suspects WHERE status = 'в розыске'");
    const reversedRows = [...ref[0].values].reverse();
    const result = makeResult({
      columns: ref[0].columns,
      rows: reversedRows,
      rowCount: reversedRows.length,
    });
    const r = validate(
      { type: "exact_match", referenceQuery: "SELECT * FROM suspects WHERE status = 'в розыске'" },
      result,
      db
    );
    expect(r.passed).toBe(true);
  });

  it("fail: разные данные", () => {
    const result = makeResult({
      columns: ["id", "name"],
      rows: [[999, "fake"]],
      rowCount: 1,
    });
    const r = validate(
      { type: "exact_match", referenceQuery: "SELECT * FROM suspects WHERE status = 'в розыске'" },
      result,
      db
    );
    expect(r.passed).toBe(false);
  });

  it("fail: разное количество столбцов", () => {
    const ref = db.exec("SELECT * FROM suspects WHERE status = 'в розыске'");
    const result = makeResult({
      columns: ["id", "name"], // only 2 columns vs 10 in reference
      rows: ref[0].values.map((r) => [r[0], r[1]]),
      rowCount: ref[0].values.length,
    });
    const r = validate(
      { type: "exact_match", referenceQuery: "SELECT * FROM suspects WHERE status = 'в розыске'" },
      result,
      db
    );
    expect(r.passed).toBe(false);
  });

  it("fail: ошибка в reference query → сообщает разработчику", () => {
    const r = validate(
      { type: "exact_match", referenceQuery: "SELECTTT broken" },
      makeResult(),
      db
    );
    expect(r.passed).toBe(false);
    expect(r.message).toContain("разработчику");
  });
});

// ─── custom ──────────────────────────────────────────────

describe("custom", () => {
  it("делегирует check-функции", () => {
    const rule: ValidationRule = {
      type: "custom",
      check: (result) => ({
        passed: result.rowCount === 42,
        message: result.rowCount === 42 ? "ok" : "nope",
      }),
    };
    expect(validate(rule, makeResult({ rowCount: 42 }), db).passed).toBe(true);
    expect(validate(rule, makeResult({ rowCount: 1 }), db).passed).toBe(false);
  });
});

// ─── requires_column ────────────────────────────────────

describe("requires_column", () => {
  it("pass: столбец найден (case-insensitive)", () => {
    const r = validate(
      { type: "requires_column", column: "Name" },
      makeResult({ columns: ["id", "name"] }),
      db
    );
    expect(r.passed).toBe(true);
  });

  it("pass: столбец + minRows выполнено", () => {
    const r = validate(
      { type: "requires_column", column: "name", minRows: 2 },
      makeResult({ columns: ["id", "name"], rowCount: 3 }),
      db
    );
    expect(r.passed).toBe(true);
  });

  it("fail: столбец отсутствует", () => {
    const r = validate(
      { type: "requires_column", column: "phone" },
      makeResult({ columns: ["id", "name"] }),
      db
    );
    expect(r.passed).toBe(false);
    expect(r.message).toContain("phone");
  });

  it("fail: столбец есть, но строк меньше minRows", () => {
    const r = validate(
      { type: "requires_column", column: "name", minRows: 5 },
      makeResult({ columns: ["id", "name"], rowCount: 2 }),
      db
    );
    expect(r.passed).toBe(false);
    expect(r.message).toContain("5");
  });
});

// ─── contains_substring ─────────────────────────────────

describe("contains_substring", () => {
  it("pass: подстрока найдена (case-insensitive)", () => {
    const r = validate(
      { type: "contains_substring", column: "content", substring: "груз" },
      makeResult({ columns: ["id", "content"], rows: [[1, "Отправить Груз в порт"]], rowCount: 1 }),
      db
    );
    expect(r.passed).toBe(true);
  });

  it("fail: столбец отсутствует", () => {
    const r = validate(
      { type: "contains_substring", column: "content", substring: "груз" },
      makeResult({ columns: ["id", "name"] }),
      db
    );
    expect(r.passed).toBe(false);
    expect(r.message).toContain("content");
  });

  it("fail: подстрока не найдена", () => {
    const r = validate(
      { type: "contains_substring", column: "content", substring: "груз" },
      makeResult({ columns: ["id", "content"], rows: [[1, "Всё тихо"]], rowCount: 1 }),
      db
    );
    expect(r.passed).toBe(false);
    expect(r.message).toContain("груз");
  });
});

// ─── value_check ────────────────────────────────────────

describe("value_check", () => {
  it("pass: eq совпадает", () => {
    const r = validate(
      { type: "value_check", row: 0, col: 0, comparison: "eq", expected: 6 },
      makeResult({ rows: [[6]], rowCount: 1 }),
      db
    );
    expect(r.passed).toBe(true);
  });

  it("pass: gt выполнено", () => {
    const r = validate(
      { type: "value_check", row: 0, col: 0, comparison: "gt", expected: 0 },
      makeResult({ rows: [[7500000]], rowCount: 1 }),
      db
    );
    expect(r.passed).toBe(true);
  });

  it("fail: eq не совпадает", () => {
    const r = validate(
      { type: "value_check", row: 0, col: 0, comparison: "eq", expected: 6 },
      makeResult({ rows: [[3]], rowCount: 1 }),
      db
    );
    expect(r.passed).toBe(false);
  });

  it("fail: строка за пределами", () => {
    const r = validate(
      { type: "value_check", row: 5, col: 0, comparison: "eq", expected: 1 },
      makeResult({ rows: [[1]], rowCount: 1 }),
      db
    );
    expect(r.passed).toBe(false);
    expect(r.message).toContain("строк");
  });

  it("fail: значение не число", () => {
    const r = validate(
      { type: "value_check", row: 0, col: 0, comparison: "eq", expected: 1 },
      makeResult({ rows: [["abc"]], rowCount: 1 }),
      db
    );
    expect(r.passed).toBe(false);
    expect(r.message).toContain("числом");
  });
});

// ─── compound ───────────────────────────────────────────

describe("compound", () => {
  it("pass: все правила прошли → successMessage", () => {
    const r = validate(
      {
        type: "compound",
        rules: [
          { type: "requires_column", column: "name" },
          { type: "row_count", expected: 1, comparison: "eq" },
        ],
        successMessage: "Всё верно!",
      },
      makeResult({ columns: ["id", "name"], rowCount: 1 }),
      db
    );
    expect(r.passed).toBe(true);
    expect(r.message).toBe("Всё верно!");
  });

  it("fail: первое правило падает", () => {
    const r = validate(
      {
        type: "compound",
        rules: [
          { type: "requires_column", column: "phone" },
          { type: "row_count", expected: 1, comparison: "eq" },
        ],
        successMessage: "Всё верно!",
      },
      makeResult({ columns: ["id", "name"], rowCount: 1 }),
      db
    );
    expect(r.passed).toBe(false);
    expect(r.message).toContain("phone");
  });

  it("fail: второе правило падает", () => {
    const r = validate(
      {
        type: "compound",
        rules: [
          { type: "requires_column", column: "name" },
          { type: "row_count", expected: 5, comparison: "eq" },
        ],
        successMessage: "Всё верно!",
      },
      makeResult({ columns: ["id", "name"], rowCount: 1 }),
      db
    );
    expect(r.passed).toBe(false);
    expect(r.message).toContain("5");
  });
});

// ─── any_of ─────────────────────────────────────────────

describe("any_of", () => {
  it("pass: первое правило прошло", () => {
    const r = validate(
      {
        type: "any_of",
        rules: [
          { type: "contains_substring", column: "content", substring: "груз" },
          { type: "contains_substring", column: "content", substring: "порт" },
        ],
        successMessage: "Найдено!",
      },
      makeResult({ columns: ["content"], rows: [["Груз отправлен"]], rowCount: 1 }),
      db
    );
    expect(r.passed).toBe(true);
    expect(r.message).toBe("Найдено!");
  });

  it("pass: только второе правило прошло", () => {
    const r = validate(
      {
        type: "any_of",
        rules: [
          { type: "contains_substring", column: "content", substring: "груз" },
          { type: "contains_substring", column: "content", substring: "порт" },
        ],
        successMessage: "Найдено!",
      },
      makeResult({ columns: ["content"], rows: [["Встреча в порту"]], rowCount: 1 }),
      db
    );
    expect(r.passed).toBe(true);
    expect(r.message).toBe("Найдено!");
  });

  it("fail: ни одно правило не прошло", () => {
    const r = validate(
      {
        type: "any_of",
        rules: [
          { type: "contains_substring", column: "content", substring: "груз" },
          { type: "contains_substring", column: "content", substring: "порт" },
        ],
        successMessage: "Найдено!",
      },
      makeResult({ columns: ["content"], rows: [["Всё тихо"]], rowCount: 1 }),
      db
    );
    expect(r.passed).toBe(false);
  });
});

describe("неполные результаты", () => {
  const truncated = makeResult({ columns: ["n"], rows: [[1], [2]], rowCount: 2, truncated: true });
  const countRule: ValidationRule = { type: "row_count", expected: 2, comparison: "eq" };

  it("не засчитывает совпадение и не превращает неопределённость в успех через not", () => {
    expect(validate(countRule, truncated, db)).toMatchObject({ passed: false, inconclusive: true });
    expect(validate({ type: "not", rule: countRule, message: "лишние строки" }, truncated, db)).toMatchObject({ passed: false, inconclusive: true });
    expect(validate({ type: "not", rule: { type: "contains_value", column: "n", value: 3 }, message: "найдено" }, truncated, db)).toMatchObject({ passed: false, inconclusive: true });
  });

  it("засчитывает найденное значение и независимые от строк правила", () => {
    expect(validate({ type: "contains_value", column: "n", value: 2 }, truncated, db).passed).toBe(true);
    expect(validate({ type: "contains_columns", columns: ["n"] }, truncated, db).passed).toBe(true);
    expect(validate({ type: "table_state", query: "SELECT 1 AS n", rule: { type: "cell_value", value: 1 } }, truncated, db).passed).toBe(true);
  });

  it("составные проверки сохраняют неопределённость, но any_of принимает доказанный вариант", () => {
    const negative: ValidationRule = { type: "not", rule: { type: "any_of", rules: [countRule, { type: "contains_value", column: "n", value: 3 }], successMessage: "да" }, message: "нет" };
    expect(validate(negative, truncated, db)).toMatchObject({ passed: false, inconclusive: true });
    expect(validate({ type: "any_of", rules: [countRule, { type: "contains_value", column: "n", value: 1 }], successMessage: "да" }, truncated, db).passed).toBe(true);
  });

  it("не сравнивает первые 5000 строк с усечённым эталоном", () => {
    const large = "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<5001) SELECT x FROM n";
    const result = makeResult({ columns: ["x"], rows: Array.from({ length: 5000 }, (_, i) => [i + 1]), rowCount: 5000 });
    const outcome = validate({ type: "not", rule: { type: "rows_match", referenceQuery: large }, message: "совпало" }, result, db);
    expect(outcome).toMatchObject({ passed: false, inconclusive: true });
  });
});
