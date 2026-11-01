/**
 * Дело № 01 «Медь» (case-01-med): контент, эталоны, ловушки, протокол,
 * допрос «Шпала» и посаженные факты разд. 8.4 (блок «Д1»). TECH_SPEC, разд. 5.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Database } from "sql.js";
import {
  checkCaseProgress,
  checkProtocol,
  collectEvidenceIds,
  executeSQL,
  exportWorld,
  generateWorld,
  openCaseDatabase,
  presentMatches,
  scanSeenOptions,
  validateCaseContent,
  type CaseDef,
  type CaseObjective,
  type PinnedCard,
  type QueryResult,
} from "@/engine";
import { cases, characters, getCase, handbookByCase } from "@/data";
import { C01 } from "@/engine/world/plants/c01";

const caseDef = getCase("case-01-med") as CaseDef;
const objective = (id: string) => caseDef.objectives.find((o) => o.id === id) as CaseObjective;
const MAIN = ["o1_start", "o1_1", "o1_night", "o1_windows", "o1_2", "o1_3", "o1_4"] as const;
const CAP = caseDef.clock?.cap as string;

let world: Database;
let db: Database;
let capDb: Database;
let generationMs = 0;

beforeAll(async () => {
  const t0 = performance.now();
  world = await generateWorld();
  generationMs = performance.now() - t0;
  const bytes = exportWorld(world);
  db = await openCaseDatabase(bytes, { clock: caseDef.date, tables: caseDef.tables });
  capDb = await openCaseDatabase(bytes, { clock: CAP, tables: caseDef.tables });
}, 60_000);

afterAll(() => {
  db?.close();
  capDb?.close();
  world?.close();
});

/** Запрос игрока: guard дела + выполнение */
const run = (sql: string, on: Database = db): QueryResult => executeSQL(on, sql, caseDef.tables);

/** Засчитывает ли запрос задачу id, если все предыдущие основные уже выполнены */
function passes(id: string, sql: string): boolean {
  const before = new Set<string>(MAIN.slice(0, Math.max(0, MAIN.indexOf(id as (typeof MAIN)[number]))));
  const result = run(sql);
  expect(result.error, sql).toBeNull();
  return checkCaseProgress(caseDef, result, db, before).completed.some((c) => c.objectiveId === id);
}

const rows = (on: Database, sql: string): unknown[][] => on.exec(sql)[0]?.values ?? [];
const one = (on: Database, sql: string): unknown => rows(on, sql)[0]?.[0];

const W = [
  "read_at BETWEEN '2026-11-30 01:00:00' AND '2026-11-30 04:00:00'",
  "read_at BETWEEN '2026-12-01 01:00:00' AND '2026-12-01 04:00:00'",
  "read_at BETWEEN '2026-12-02 01:00:00' AND '2026-12-02 04:00:00'",
];
const WINDOWS = `(${W.join(" OR ")})`;
const WINDOWS_HALF_OPEN =
  "((read_at >= '2026-11-30 01:00:00' AND read_at < '2026-11-30 04:00:01') OR " +
  "(read_at >= '2026-12-01 01:00:00' AND read_at < '2026-12-01 04:00:01') OR " +
  "(read_at >= '2026-12-02 01:00:00' AND read_at < '2026-12-02 04:00:01'))";

// ==================================================================== контент

describe("контент дела", () => {
  it("мир сгенерирован за разумное время", () => {
    expect(generationMs).toBeLessThan(15_000);
  });

  it("validateCaseContent → []", () => {
    expect(validateCaseContent(caseDef, characters, collectEvidenceIds(cases))).toEqual([]);
  });

  it("карточка дела по библии: старт 03.12 21:30, потолок 23:59, таблицы и понятия Д1", () => {
    expect(caseDef.date).toBe("2026-12-03 21:30");
    expect(caseDef.clock?.cap).toBe("2026-12-03 23:59");
    expect(caseDef.minutesPerQuery).toBe(1);
    expect(caseDef.difficulty).toBe("easy");
    expect(caseDef.newTables).toEqual(["cameras", "plate_reads", "vehicles"]);
    expect(caseDef.concepts).toEqual(["h.or_parens", "h.in", "h.between", "h.like", "h.is_null", "h.distinct", "w.plates"]);
    expect(caseDef.objectives.filter((o) => !o.optional).map((o) => o.id)).toEqual([...MAIN]);
  });

  it("у каждой задачи 3–4 подсказки голосами, улика ev.c01.*, эталон", () => {
    for (const o of caseDef.objectives) {
      expect(o.hints.length, o.id).toBeGreaterThanOrEqual(3);
      expect(o.hints.length, o.id).toBeLessThanOrEqual(4);
      for (const h of o.hints) expect(h.by, o.id).toBeTruthy();
      if (!["o1_start", "o1_night", "o1_windows"].includes(o.id)) expect(o.hints[0].line, o.id).toBe(`hint.c01_${o.id}.001`);
      if (!["o1_start", "o1_night", "o1_windows"].includes(o.id)) expect(o.evidence?.id, o.id).toMatch(/^ev\.c01\./);
      expect(o.solution.trim(), o.id).not.toBe("");
    }
  });

  it("SQL в подсказках (кроме шаблонов с пропусками) выполняется на таблицах дела", () => {
    for (const o of caseDef.objectives) {
      for (const h of o.hints) {
        const at = h.text.indexOf("SELECT");
        if (at < 0 || /__|…/.test(h.text)) continue;
        const sql = h.text.slice(at).replace(/`$/, "");
        expect(run(sql).error, `${o.id}: ${sql}`).toBeNull();
      }
    }
  });

  it("справочник: статьи на все понятия дела, примеры выполняются на таблицах дела", () => {
    const entries = handbookByCase.c01;
    expect(entries.map((e) => e.id).sort()).toEqual([...caseDef.concepts].sort());
    for (const e of entries) {
      if (!e.id.startsWith("h.") && e.id !== "w.plates") continue;
      const result = run(e.example);
      expect(result.error, `${e.id}: ${e.example}`).toBeNull();
      expect(result.rowCount, e.id).toBeGreaterThan(0);
    }
  });
});

// ==================================================================== эталоны

describe("эталоны задач", () => {
  it("основные задачи проходят по порядку, каждая — своим эталоном", () => {
    const done = new Set<string>();
    for (const id of MAIN) {
      const o = objective(id);
      const result = run(o.solution);
      expect(result.error, `${id}: ${o.solution}`).toBeNull();
      const progress = checkCaseProgress(caseDef, result, db, done);
      expect(progress.completed.map((c) => c.objectiveId), id).toEqual([id]);
      expect(progress.completed[0].evidence?.id).toBe(o.evidence?.id);
      done.add(id);
    }
    expect(done.size).toBe(MAIN.length);
  });

  it("★ o1_4b засчитывается своим эталоном и не срабатывает на эталонах основных задач", () => {
    const star = objective("o1_4b");
    expect(star.optional).toBe(true);
    const result = run(star.solution);
    expect(result.error).toBeNull();
    expect(result.rows).toEqual([["К372ОК", 3]]);
    expect(checkCaseProgress(caseDef, result, db, new Set(MAIN)).completed.map((c) => c.objectiveId)).toEqual(["o1_4b"]);
    for (const id of MAIN) {
      const before = new Set<string>(MAIN.slice(0, MAIN.indexOf(id)));
      const got = checkCaseProgress(caseDef, run(objective(id).solution), db, before).completed.map((c) => c.objectiveId);
      expect(got, id).not.toContain("o1_4b");
    }
  });

  it("эталоны проходят guard с таблицами дела, а закрытые таблицы — нет", () => {
    for (const o of caseDef.objectives) expect(run(o.solution).error, o.id).toBeNull();
    const denied = executeSQL(db, "SELECT * FROM persons WHERE id = 2307", caseDef.tables);
    expect(denied.error).not.toBeNull();
    expect(denied.errorKind).toBe("locked_table");
  });

  it("каждый эталон быстрее 1 с и не больше 5 000 строк", () => {
    for (const o of caseDef.objectives) {
      const t0 = performance.now();
      const result = run(o.solution);
      expect(performance.now() - t0, o.id).toBeLessThan(1000);
      expect(result.rowCount, o.id).toBeLessThanOrEqual(5000);
    }
  });

  it("эталоны дают один ответ на старте дела и на потолке часов", () => {
    for (const o of caseDef.objectives) {
      expect(run(o.solution, capDb).rows, o.id).toEqual(run(o.solution).rows);
    }
  });

  it("строгая лестница: в эталонах основных задач только понятия П и Д1", () => {
    const FUTURE = /\b(JOIN|GROUP\s+BY|HAVING|COUNT|SUM|AVG|MIN|MAX|ROUND|AS|CASE|WITH|OVER|EXISTS|UNION|EXCEPT|INTERSECT|COALESCE|IFNULL|date|time|datetime|strftime|julianday|replace|substr|instr|length|trim)\b|\|\|/i;
    for (const id of MAIN) expect(objective(id).solution, id).not.toMatch(FUTURE);
  });
});

// ==================================================================== альтернативы и ловушки

describe("1.1 «Кражи кабеля за эти ночи»", () => {
  it("эталон: ровно три утренних заявления", () => {
    expect(run(objective("o1_1").solution).rows.map((r) => r[0])).toEqual([1683, 1690, 1697]);
  });

  it("альтернативы засчитываются", () => {
    expect(passes("o1_1", "SELECT kusp_no, reported_at FROM incidents WHERE kind = 'кража' AND description LIKE '%медный кабель%' AND reported_at >= '2026-11-30' AND reported_at < '2026-12-03'")).toBe(true);
    expect(passes("o1_1", "SELECT * FROM incidents WHERE description LIKE '%КАБЕЛ%' AND kind IN ('кража') AND reported_at BETWEEN '2026-11-29 12:00:00' AND '2026-12-03 12:00:00' ORDER BY id DESC")).toBe(true);
  });

  it("ловушки не засчитываются", () => {
    // без вида: ночной звонок сторожа тоже про кабель
    expect(passes("o1_1", "SELECT reported_at, description FROM incidents WHERE description LIKE '%кабел%' AND reported_at BETWEEN '2026-11-30 00:00:00' AND '2026-12-02 23:59:59'")).toBe(false);
    // без дат: кражи кабеля весь год
    expect(passes("o1_1", "SELECT reported_at, description FROM incidents WHERE kind = 'кража' AND description LIKE '%кабел%'")).toBe(false);
    // верхняя граница-дата без времени отрезает 02.12
    expect(run("SELECT id FROM incidents WHERE kind = 'кража' AND description LIKE '%кабел%' AND reported_at BETWEEN '2026-11-30' AND '2026-12-02'").rowCount).toBe(2);
    expect(passes("o1_1", "SELECT reported_at FROM incidents WHERE kind = 'кража' AND description LIKE '%кабел%' AND reported_at BETWEEN '2026-11-30' AND '2026-12-02'")).toBe(false);
    // дата не в ISO и точное совпадение вместо LIKE
    expect(passes("o1_1", "SELECT reported_at FROM incidents WHERE kind = 'кража' AND description LIKE '%кабел%' AND reported_at BETWEEN '30.11.2026' AND '02.12.2026'")).toBe(false);
    expect(passes("o1_1", "SELECT reported_at FROM incidents WHERE kind = 'кража' AND description = 'кабель' AND reported_at BETWEEN '2026-11-30 00:00:00' AND '2026-12-02 23:59:59'")).toBe(false);
  });
});

describe("1.2 «Номера с 372 на камере 12»", () => {
  it("эталон: К372ОК, K372OK, Е372ВХ", () => {
    expect(run(objective("o1_2").solution).rows.map((r) => r[0]).sort()).toEqual(["K372OK", "Е372ВХ", "К372ОК"].sort());
  });

  it("альтернативы засчитываются", () => {
    expect(passes("o1_2", `SELECT plate, read_at, confidence FROM plate_reads WHERE camera_id = 12 AND plate LIKE '%372%' AND ${WINDOWS_HALF_OPEN} ORDER BY read_at`)).toBe(true);
    expect(passes("o1_2", `SELECT DISTINCT plate AS номер FROM plate_reads WHERE plate LIKE '%37%' AND camera_id IN (12) AND ${WINDOWS}`)).toBe(true);
  });

  it("ловушки не засчитываются", () => {
    // без скобок: окна второй и третьей ночи — со всех камер и с любыми номерами
    const noParens = `SELECT DISTINCT plate FROM plate_reads WHERE camera_id = 12 AND plate LIKE '%372%' AND ${W.join(" OR ")}`;
    expect(run(noParens).rowCount).toBeGreaterThan(3);
    expect(passes("o1_2", noParens)).toBe(false);
    // забыт camera_id: транзитный А372ТМ на площади Труда
    expect(passes("o1_2", `SELECT DISTINCT plate FROM plate_reads WHERE plate LIKE '%372%' AND ${WINDOWS}`)).toBe(false);
    // точное совпадение вместо образца
    expect(passes("o1_2", `SELECT DISTINCT plate FROM plate_reads WHERE camera_id = 12 AND plate = 'К372ОК' AND ${WINDOWS}`)).toBe(false);
    // «37» и ночь целиком: хлебовоз Р037АА в 05:00–05:10
    const bread = "SELECT DISTINCT plate FROM plate_reads WHERE camera_id = 12 AND plate LIKE '%37%' AND (" +
      "read_at BETWEEN '2026-11-30 00:00:00' AND '2026-11-30 06:00:00' OR read_at BETWEEN '2026-12-01 00:00:00' AND '2026-12-01 06:00:00' " +
      "OR read_at BETWEEN '2026-12-02 00:00:00' AND '2026-12-02 06:00:00')";
    expect(run(bread).rows.map((r) => r[0])).toContain(C01.plates.bread);
    expect(passes("o1_2", bread)).toBe(false);
  });
});

describe("1.3 «Чьи это машины?»", () => {
  it("эталон: одна машина — К372ОК Шпакова, не продана и не снята с учёта", () => {
    expect(run(objective("o1_3").solution).rows).toEqual([
      ["К372ОК", "САЙГАК", "синий", "Шпаков Георгий Ильич", "2019-06-14", null, null],
    ]);
  });

  it("альтернативы засчитываются", () => {
    expect(passes("o1_3", "SELECT * FROM vehicles WHERE make LIKE '%сайгак%' AND color = 'синий' AND deregistered_at IS NULL")).toBe(true);
    expect(passes("o1_3", "SELECT owner_name, plate, sold_at FROM vehicles WHERE (plate = 'К372ОК' OR plate = 'Е372ВХ') AND make LIKE 'сайгак%'")).toBe(true);
  });

  it("ловушки не засчитываются", () => {
    // = вместо LIKE: в реестре «САЙГАК», а не «Сайгак»
    const exact = "SELECT plate, owner_name FROM vehicles WHERE plate IN ('К372ОК', 'K372OK', 'Е372ВХ') AND make = 'Сайгак' AND deregistered_at IS NULL";
    expect(run(exact).rowCount).toBe(0);
    expect(passes("o1_3", exact)).toBe(false);
    // без IS NULL: снятый с учёта М537ТН
    expect(passes("o1_3", "SELECT plate, owner_name, deregistered_at FROM vehicles WHERE make LIKE '%сайгак%' AND color = 'синий'")).toBe(false);
    // = NULL не находит ничего
    expect(passes("o1_3", "SELECT plate, owner_name FROM vehicles WHERE make LIKE '%сайгак%' AND color = 'синий' AND deregistered_at = NULL")).toBe(false);
    // без марки: белая «Вега» Е372ВХ
    expect(passes("o1_3", "SELECT plate, make, owner_name FROM vehicles WHERE plate IN ('К372ОК', 'K372OK', 'Е372ВХ')")).toBe(false);
  });
});

describe("1.4 «Камера 12 ×3»", () => {
  it("эталон: три ночных проезда на выезд", () => {
    expect(run(objective("o1_4").solution).rows.map((r) => [r[0], r[1]])).toEqual(C01.vanNightReads.map((r) => [r.at, r.plate]));
  });

  it("альтернативы засчитываются", () => {
    expect(passes("o1_4", `SELECT * FROM plate_reads WHERE camera_id = 12 AND (plate = 'К372ОК' OR plate = 'K372OK') AND ${WINDOWS_HALF_OPEN}`)).toBe(true);
    expect(passes("o1_4", `SELECT read_at, plate FROM plate_reads WHERE camera_id = 12 AND plate LIKE '%372%' AND plate <> 'Е372ВХ' AND ${WINDOWS} ORDER BY read_at DESC`)).toBe(true);
  });

  it("ловушки не засчитываются", () => {
    // кириллица только: латинский двойник потерян
    const cyrOnly = `SELECT read_at, plate FROM plate_reads WHERE camera_id = 12 AND plate = 'К372ОК' AND ${WINDOWS}`;
    expect(run(cyrOnly).rowCount).toBe(2);
    expect(passes("o1_4", cyrOnly)).toBe(false);
    // по цифрам без отсева: белая «Вега»
    expect(passes("o1_4", `SELECT read_at, plate FROM plate_reads WHERE camera_id = 12 AND plate LIKE '%372%' AND ${WINDOWS}`)).toBe(false);
    // без окон: дневные проезды
    expect(passes("o1_4", "SELECT read_at, plate FROM plate_reads WHERE camera_id = 12 AND plate IN ('К372ОК', 'K372OK')")).toBe(false);
    // без камеры: Объездная
    expect(passes("o1_4", `SELECT read_at, plate FROM plate_reads WHERE plate IN ('К372ОК', 'K372OK') AND ${WINDOWS}`)).toBe(false);
    // сутки вместо ночей: 01.12 14:22
    expect(passes("o1_4", "SELECT read_at, plate FROM plate_reads WHERE camera_id = 12 AND plate IN ('К372ОК', 'K372OK') AND read_at BETWEEN '2026-11-30' AND '2026-12-03'")).toBe(false);
  });
});

describe("★ 1.4б «Один номер — три ночи»", () => {
  const starPasses = (sql: string) => {
    const result = run(sql);
    expect(result.error, sql).toBeNull();
    return checkCaseProgress(caseDef, result, db, new Set(MAIN)).completed.some((c) => c.objectiveId === "o1_4b");
  };

  it("альтернатива: агрегат по списку номеров", () => {
    expect(starPasses(`SELECT MIN(plate) AS plate, COUNT(*) AS nights FROM plate_reads WHERE camera_id = 12 AND plate IN ('К372ОК', 'K372OK') AND ${WINDOWS}`)).toBe(true);
  });

  it("ловушки: точная группировка и хлебовоз", () => {
    expect(starPasses(`SELECT plate, COUNT(*) FROM plate_reads WHERE camera_id = 12 AND ${WINDOWS} GROUP BY plate HAVING COUNT(*) = 3`)).toBe(false);
    expect(starPasses("SELECT plate, COUNT(DISTINCT date(read_at)) AS n FROM plate_reads WHERE camera_id = 12 AND read_at BETWEEN '2026-11-30 00:00:00' AND '2026-12-02 06:00:00' AND time(read_at) < '06:00:00' GROUP BY plate HAVING n = 3")).toBe(false);
  });
});

// ==================================================================== протокол

describe("протокол", () => {
  const protocol = caseDef.protocol!;

  it("три пропуска по библии: номер, владелец, первая ночь", () => {
    expect(protocol.blanks.map((b) => [b.id, b.kind, b.answer])).toEqual([
      ["plate", "text", "К372ОК"],
      ["owner", "text", "Шпаков Георгий Ильич"],
      ["first_night", "datetime", "2026-11-30 02:47:00"],
    ]);
  });

  it("каждый ответ виден в результатах эталонов (scanSeenOptions)", () => {
    const seen = new Set<string>();
    for (const o of caseDef.objectives.filter((x) => !x.optional)) for (const v of scanSeenOptions(protocol, run(o.solution))) seen.add(v);
    for (const b of protocol.blanks) expect(seen.has(b.answer), b.id).toBe(true);
  });

  it("верные ответы подтверждаются, неверные — нет", () => {
    const right = Object.fromEntries(protocol.blanks.map((b) => [b.id, b.answer]));
    expect(checkProtocol(protocol, right, new Set()).solved).toBe(true);
    expect(checkProtocol(protocol, { ...right, plate: "K372OK" }, new Set()).newlyConfirmed).toEqual([]);
    expect(checkProtocol(protocol, { ...right, owner: "УК «Шахтный»" }, new Set()).newlyConfirmed).toEqual([]);
    expect(checkProtocol(protocol, { ...right, first_night: "2026-11-30 08:20:00" }, new Set()).newlyConfirmed).toEqual([]);
  });
});

// ==================================================================== допрос

describe("допрос «Шпала»", () => {
  const scene = caseDef.scenes.find((s) => s.id === "int_shpala")!;
  const int = scene.interrogation!;
  const point = (n: string) => int.points.find((p) => p.line === `c01.int_shpala.${n}`)!;
  const card = (table: string, result: QueryResult, row = 0): PinnedCard => ({
    id: `${table}-${row}`, columns: result.columns, values: result.rows[row] as PinnedCard["values"], table, sourceClass: "dorset",
  });

  it("утверждения из библии: .003 «продал в сентябре», .005 «дома спал»; шаги пробоя shpala", () => {
    const text = (id: string) => scene.lines.find((l) => l.id === id)?.text;
    expect(text("c01.int_shpala.003")).toBe("Сайгак я ещё в сентябре продал, начальник.");
    expect(text("c01.int_shpala.005")).toBe("В ту ночь дома спал, век воли не видать.");
    expect(int.breakSteps).toEqual(["neutral", "scared", "happy"]);
  });

  it("пробивают улики дела и строки эталонов как карточки", () => {
    expect(presentMatches(point("003").present!, { evidenceIds: ["ev.c01.vehicle"] })).toBe(true);
    expect(presentMatches(point("005").present!, { evidenceIds: ["ev.c01.cam12_x3"] })).toBe(true);
    expect(presentMatches(point("003").present!, { evidenceIds: ["ev.c01.cam12_x3"] })).toBe(false);
    expect(presentMatches(point("005").present!, { evidenceIds: ["ev.c01.vehicle"] })).toBe(false);
    const vehicle = card("vehicles", run(objective("o1_3").solution));
    expect(presentMatches(point("003").present!, { cards: [vehicle] })).toBe(true);
    const reads = run(objective("o1_4").solution);
    for (let i = 0; i < reads.rowCount; i++) {
      expect(presentMatches(point("005").present!, { cards: [card("plate_reads", reads, i)] }), String(i)).toBe(true);
    }
    const daytime = run("SELECT read_at, plate FROM plate_reads WHERE plate = 'К372ОК' AND read_at = '2026-12-01 14:22:51'");
    expect(presentMatches(point("005").present!, { cards: [card("plate_reads", daytime)] })).toBe(false);
  });

  it("М2: признание после второго пробоя — «Щит», Бурый, кольцо не налезет", () => {
    const confess = caseDef.scenes.find((s) => s.id === int.doneScene)!;
    const texts = confess.lines.map((l) => l.text);
    expect(texts).toContain("Медь — на приёмку. А охрана подстанции — «Щит». Им отстёгивали, чтоб не смотрели. Бурый лично брал.");
    expect(texts).toContain("И как он выглядит, этот Бурый?");
    expect(texts).toContain("Обычный. Безымянный у него короче — лебёдка откусила. Кольцо не налезет.");
  });
});

// ==================================================================== сценарий

describe("сценарий", () => {
  const lines = caseDef.scenes.flatMap((s) => s.lines);

  it("c01.intro.004 — Даша про дядю Лёву (подготовка Д6)", () => {
    expect(lines.find((l) => l.id === "c01.intro.004")).toMatchObject({
      speaker: "dasha",
      text: "Меня в ОЦР дядя Лёва первого числа перетащил. Из патруля. Он с батей моим на корюшку ходил.",
    });
    expect(lines.find((l) => l.id === "c01.intro.002")?.text).toBe("Ну-с, медь. Классика.");
  });

  it("реплики короткие: не длиннее 160 знаков, в озвучке нет цифр", () => {
    for (const l of lines) {
      expect(l.text.length, l.id).toBeLessThanOrEqual(160);
      if (l.speaker !== "narrator") expect(l.text, l.id).not.toMatch(/\d/);
    }
  });

  it("к игроку без родовых форм прошедшего времени и кратких прилагательных", () => {
    const toPlayer = /\b(ты|Ты)\s+(\S+(л|ла|лся|лась)|готов|готова|сам|сама|прав|права|рад|рада)\b/u;
    const choices = caseDef.scenes.flatMap((s) => (s.choices ?? []).map((c) => c.say ?? c.text));
    for (const l of lines) expect(l.text, l.id).not.toMatch(toPlayer);
    for (const c of choices) expect(c).not.toMatch(/\b(я|Я)\s+\S+(л|ла)\b|\b(готов|готова|сам|сама)\b/u);
  });
});

// ==================================================================== посаженные факты (разд. 8.4, Д1)

describe("посаженные факты Д1", () => {
  it("incidents 1683, 1690, 1697 — утренние заявления о кражах кабеля", () => {
    expect(rows(world, "SELECT id, kusp_no, reported_at, kind, district, description FROM incidents WHERE id IN (1683, 1690, 1697) ORDER BY id")).toEqual([
      [1683, 4688, "2026-11-30 08:20:00", "кража", "Промзона", C01.theftText],
      [1690, 4703, "2026-12-01 08:05:00", "кража", "Промзона", C01.theftText],
      [1697, 4717, "2026-12-02 08:15:00", "кража", "Промзона", C01.theftText],
    ]);
    // ровно три кражи кабеля с 16.11: шум их не повторяет
    expect(one(db, "SELECT COUNT(*) FROM incidents WHERE kind = 'кража' AND description LIKE '%кабел%' AND reported_at >= '2026-11-16'")).toBe(3);
    expect(one(world, "SELECT COUNT(*) FROM incidents WHERE kusp_no IN (4688, 4703, 4717)")).toBe(3);
  });

  it("камера 12 — «Промзона — выезд (Энергетиков)»", () => {
    expect(one(world, "SELECT name FROM cameras WHERE id = 12")).toBe("Промзона — выезд (Энергетиков)");
  });

  it("ровно одна машина: синий «Сайгак», не снятый с учёта, — К372ОК Шпакова (2307)", () => {
    expect(rows(db, "SELECT plate FROM vehicles WHERE make LIKE '%сайгак%' AND color = 'синий' AND deregistered_at IS NULL")).toEqual([["К372ОК"]]);
    expect(rows(world, "SELECT make, color, owner_person_id, owner_name, sold_at, deregistered_at FROM vehicles WHERE plate = 'К372ОК'")).toEqual([
      ["САЙГАК", "синий", 2307, "Шпаков Георгий Ильич", null, null],
    ]);
    expect(one(world, "SELECT full_name FROM persons WHERE id = 2307")).toBe("Шпаков Георгий Ильич");
  });

  it("K372OK (латиница) в реестре нет; М537ТН снят с учёта 11.04.2024; Е372ВХ — белая «Вега Гранд»", () => {
    expect(one(world, "SELECT COUNT(*) FROM vehicles WHERE plate = 'K372OK'")).toBe(0);
    expect(rows(world, "SELECT make, color, deregistered_at FROM vehicles WHERE plate = 'М537ТН'")).toEqual([["Сайгак", "синий", "2024-04-11"]]);
    expect(rows(world, "SELECT make, model, color FROM vehicles WHERE plate = 'Е372ВХ'")).toEqual([["Вега", "Гранд", "белый"]]);
    expect(rows(db, "SELECT plate FROM vehicles WHERE plate LIKE '%372%' ORDER BY plate")).toEqual([["Е372ВХ"], ["К372ОК"]]);
  });

  it("«Сайгаков» 14, записаны четырьмя способами, 'Сайгак' — только 5", () => {
    expect(one(db, "SELECT COUNT(*) FROM vehicles WHERE make LIKE '%сайгак%'")).toBe(C01.saigakTotal);
    expect(one(world, "SELECT COUNT(*) FROM vehicles WHERE make = 'Сайгак'")).toBe(C01.saigakExact);
    expect(rows(db, "SELECT DISTINCT make FROM vehicles WHERE make LIKE '%сайгак%' ORDER BY make").map((r) => r[0]).sort()).toEqual(
      ["САЙГАК", "Сайгак", "СайгаК", "Сайгак Next"].sort()
    );
    // хлебовоз Р037АА — тоже «Сайгак» (белый «Сайгак Next»)
    expect(rows(world, "SELECT make, color FROM vehicles WHERE plate = 'Р037АА'")).toEqual([["Сайгак Next", "белый"]]);
  });

  it("камера 12 в три ночи 01:00–04:00: только К372ОК 02:47, K372OK 02:41, К372ОК 02:52, Е372ВХ 03:30", () => {
    const sql = `SELECT read_at, plate FROM plate_reads WHERE camera_id = 12 AND ${WINDOWS} ORDER BY read_at`;
    expect(rows(world, sql)).toEqual([
      ["2026-11-30 02:47:00", "К372ОК"],
      ["2026-12-01 02:41:00", "K372OK"],
      ["2026-12-01 03:30:00", "Е372ВХ"],
      ["2026-12-02 02:52:00", "К372ОК"],
    ]);
    // номеров с «372» в «Дорсети» — только посаженные
    expect(one(db, "SELECT COUNT(*) FROM plate_reads WHERE plate LIKE '%372%'")).toBe(11);
  });

  it("хлебовоз Р037АА — каждую ночь через камеру 12 в 05:00–05:10, и только там", () => {
    const reads = rows(world, "SELECT camera_id, read_at FROM plate_reads WHERE plate = 'Р037АА' ORDER BY read_at");
    expect(reads.length).toBe(58);
    for (const [camera, at] of reads) {
      expect(camera).toBe(12);
      const t = String(at).slice(11);
      expect(t > "05:00:00" && t < "05:10:00", String(at)).toBe(true);
    }
    // на камере 12 в ночи 29.11–03.12 других номеров с «37» нет
    expect(one(db, "SELECT COUNT(*) FROM plate_reads WHERE camera_id = 12 AND plate LIKE '%37%' AND plate NOT LIKE '%372%' AND plate <> 'Р037АА' AND read_at BETWEEN '2026-11-29 00:00:00' AND '2026-12-04 00:00:00' AND substr(read_at, 12) < '06:00:00'")).toBe(0);
  });

  it("ни одна посаженная дата не лежит на границе окон задач", () => {
    const planted = rows(world, "SELECT read_at FROM plate_reads WHERE plate IN ('К372ОК', 'K372OK', 'Е372ВХ', 'А372ТМ', 'Р037АА')").map((r) => String(r[0]).slice(11));
    for (const t of planted) expect(["01:00:00", "04:00:00", "05:00:00", "05:10:00", "00:00:00", "06:00:00"], t).not.toContain(t);
    const thefts = rows(world, "SELECT reported_at FROM incidents WHERE id IN (1683, 1690, 1697)").map((r) => String(r[0]).slice(11));
    for (const t of thefts) expect(["00:00:00", "23:59:59"]).not.toContain(t);
  });

  it("временный триггер посадки снят после генерации", () => {
    expect(one(world, "SELECT COUNT(*) FROM sqlite_temp_master WHERE type = 'trigger'")).toBe(0);
  });
});
