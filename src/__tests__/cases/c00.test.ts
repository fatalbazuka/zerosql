/**
 * Пролог «Нулевой этаж» (case-00-nulevoy-etazh): контент, эталоны, ловушки,
 * протокол и посаженные факты разд. 8.4 (блок «П») — по TECH_SPEC, разд. 5.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { Database } from "sql.js";
import {
  checkCaseProgress,
  checkProtocol,
  collectEvidenceIds,
  executeSQL,
  getSchema,
  isBlankCorrect,
  isCaseObjectivesDone,
  lintSql,
  mainObjectives,
  openCaseDatabase,
  availableOptions,
  scanSeen,
  scanSeenOptions,
  validateCaseContent,
  type CaseDef,
  type CaseObjective,
  type QueryResult,
} from "@/engine";
import { cases, characters, getCase, handbookById } from "@/data";
import {
  C00_ANSWERS,
  C00_QUIET_WINDOW,
  CITIZEN_REPORTS_DESC,
  EVENING_INCIDENTS,
  SCHOOL_CARD,
} from "@/engine/world/plants/c00";
import * as F from "@/engine/world/facts";
import { sharedWorld, one, rows } from "../world/helpers";

const CASE_ID = "case-00-nulevoy-etazh";
const PLAYER_NAME = "Северов";

let world: Database;
let bytes: Uint8Array;
let generationMs: number;
/** База дела на старте часов (18:05) и на потолке (18:35) */
let db: Database;
let dbCap: Database;
let c00: CaseDef;

const openAt = (clock: string) =>
  openCaseDatabase(bytes, {
    clock,
    tables: c00.tables,
    patches: [{ id: "p0.player", params: { playerName: PLAYER_NAME } }],
  });

beforeAll(async () => {
  ({ db: world, bytes, ms: generationMs } = await sharedWorld());
  c00 = getCase(CASE_ID) as CaseDef;
  db = await openAt(c00.date);
  dbCap = await openAt(c00.clock?.cap as string);
}, 60_000);

const run = (sql: string, base: Database = db): QueryResult => executeSQL(base, sql, c00.tables);

const objective = (id: string): CaseObjective => {
  const o = c00.objectives.find((x) => x.id === id);
  if (!o) throw new Error(`нет задачи ${id}`);
  return o;
};

/** Основные задачи, которые идут раньше этой (их считаем выполненными) */
function doneBefore(id: string): Set<string> {
  const o = objective(id);
  if (o.optional) return new Set(mainObjectives(c00).map((m) => m.id));
  return new Set(mainObjectives(c00).filter((m) => m.order < o.order).map((m) => m.id));
}

/** Засчитывает ли запрос задачу id, когда она текущая */
function passes(id: string, sql: string, base: Database = db): boolean {
  const result = run(sql, base);
  const progress = checkCaseProgress(c00, result, base, doneBefore(id));
  return progress.completed.some((c) => c.objectiveId === id);
}

/** Сообщение валидатора для текущей задачи */
function feedback(id: string, sql: string): string | null {
  return checkCaseProgress(c00, run(sql), db, doneBefore(id)).activeFeedback;
}

// ------------------------------------------------------------------ альтернативы и ошибки

const ALTERNATIVES: Record<string, string[]> = {
  p3a: ["SELECT description, address_text, reported_at FROM incidents WHERE reported_at >= '2026-12-02 16:00:00';"],
  p3b: ["SELECT * FROM incidents WHERE kind = 'сообщение гражданина' AND reported_at >= '2026-12-02 16:00:00';"],
  p1: [
    "select * from incidents limit 10",
    "SELECT * FROM incidents WHERE id <= 10;",
  ],
  p2: [
    "SELECT id, reported_at, district, kind, description FROM incidents LIMIT 10;",
    "SELECT description, kind, district, reported_at FROM incidents LIMIT 10;",
    "SELECT reported_at, district, kind, description FROM incidents WHERE id <= 10;",
  ],
  p3: [
    "SELECT id, reported_at, kind, description FROM incidents WHERE reported_at >= '2026-12-02 16:00:00' ORDER BY reported_at;",
    "SELECT reported_at, kind FROM incidents WHERE reported_at > '2026-12-02 16:00';",
    "SELECT description FROM incidents WHERE reported_at >= '2026-12-02 16:00:00' AND reported_at <= '2026-12-02 18:05:00';",
  ],
  p4: [
    "SELECT * FROM incidents WHERE kind = 'сообщение гражданина' AND reported_at >= '2026-12-02 16:00:00' ORDER BY reported_at DESC;",
    "SELECT address_text, reported_at FROM incidents WHERE reported_at > '2026-12-02 15:59:59' AND kind = 'сообщение гражданина' ORDER BY id DESC;",
  ],
  p5: [
    "SELECT * FROM staff WHERE login = 'nol';",
    "SELECT full_name, position, badge_id FROM staff WHERE badge_id = 'B-9000';",
    "SELECT * FROM staff WHERE hired_at = '2026-12-02';",
    "SELECT * FROM staff ORDER BY id DESC LIMIT 1;",
    // только своё имя — имя игрока подставляется патчем p0.player
    "SELECT full_name FROM staff WHERE login = 'nol';",
  ],
  p4b: [
    "SELECT * FROM transit_taps WHERE holder_text = 'Лаптев М. А.';",
    "SELECT ts, card_no, holder_text FROM transit_taps WHERE stop = 'Музыкальная школа' AND ts >= '2026-12-02 16:00:00' ORDER BY ts;",
  ],
};

const MISTAKES: Record<string, string[]> = {
  p3a: ["SELECT * FROM staff", "SELECT reported_at FROM incidents WHERE reported_at >= '2026-12-02 16:00:00'"],
  p3b: ["SELECT * FROM staff", "SELECT * FROM incidents WHERE reported_at >= '2026-12-02 16:00:00'"],
  p1: [
    "SELECT * FROM incidents LIMIT 5;",
    "SELECT * FROM incidents WHERE id > 40 LIMIT 10;",
    "SELECT * FORM incidents LIMIT 10;",
  ],
  p2: [
    // звёздочка осталась
    "SELECT * FROM incidents LIMIT 10;",
    // забыт столбец
    "SELECT reported_at, district, kind FROM incidents LIMIT 10;",
    // забыт LIMIT — весь журнал
    "SELECT reported_at, district, kind, description FROM incidents;",
    // лишняя запятая перед FROM
    "SELECT reported_at, district, kind, description, FROM incidents LIMIT 10;",
  ],
  p3: [
    // ловушка пролога: дата не в ISO — «>=» отдаёт весь журнал, «=» — ничего
    "SELECT * FROM incidents WHERE reported_at >= '02.12.2026';",
    "SELECT * FROM incidents WHERE reported_at = '02.12.2026';",
    "SELECT * FROM incidents WHERE reported_at >= '02.12.2026 16:00:00';",
    // весь день, а не после 16:00
    "SELECT * FROM incidents WHERE reported_at >= '2026-12-02';",
    // раньше времени отфильтровали вид
    "SELECT * FROM incidents WHERE reported_at >= '2026-12-02 16:00:00' AND kind = 'сообщение гражданина';",
  ],
  p4: [
    // забыт DESC: сверху старое
    "SELECT reported_at, district, address_text, description FROM incidents WHERE reported_at >= '2026-12-02 16:00:00' AND kind = 'сообщение гражданина' ORDER BY reported_at;",
    // забыт фильтр по времени — сообщения за весь год
    "SELECT reported_at, address_text FROM incidents WHERE kind = 'сообщение гражданина' ORDER BY reported_at DESC;",
    // неточное значение вида
    "SELECT reported_at, address_text FROM incidents WHERE reported_at >= '2026-12-02 16:00:00' AND kind = 'сообщение' ORDER BY reported_at DESC;",
    // нет места — Даше некуда ехать
    "SELECT reported_at, description FROM incidents WHERE reported_at >= '2026-12-02 16:00:00' AND kind = 'сообщение гражданина' ORDER BY reported_at DESC;",
  ],
  p5: [
    "SELECT * FROM staff;",
    "SELECT * FROM staff WHERE login = nol;",
    // кириллическая «В» в номере пропуска
    "SELECT * FROM staff WHERE badge_id = 'В-9000';",
    // ложный след: строка Ирины за той же станцией — это не ты
    "SELECT * FROM staff WHERE workstation = 'WS-03' AND fired_at = '2026-11-19';",
  ],
  p4b: [
    "SELECT * FROM transit_taps;",
    "SELECT ts, card_no, holder_text, route, stop FROM transit_taps WHERE route = '3' AND card_kind = 'Школьная' ORDER BY ts;",
    "SELECT * FROM transit_taps WHERE holder_text = 'Лаптев М.А.';",
    "SELECT * FROM transit_taps WHERE route = '3' ORDER BY ts;",
  ],
};


/** Ключевые слова из более поздних дел (строгая лестница, разд. 4.1, п. 8) */
const FUTURE_KEYWORDS = [
  "OR", "IN", "BETWEEN", "LIKE", "GLOB", "IS", "NULL", "NOT", "DISTINCT", "COUNT", "SUM", "AVG", "MIN", "MAX",
  "ROUND", "AS", "GROUP", "HAVING", "JOIN", "ON", "LEFT", "INNER", "COALESCE", "IFNULL", "EXISTS", "CASE",
  "WITH", "UNION", "EXCEPT", "INTERSECT", "OVER", "PARTITION", "DATE", "DATETIME", "STRFTIME", "JULIANDAY",
  "SUBSTR", "LENGTH", "REPLACE", "INSERT", "UPDATE", "DELETE",
];

function keywordsOf(sql: string): string[] {
  const bare = sql.replace(/'(?:[^']|'')*'/g, "''");
  return (bare.match(/[A-Za-z_]+/g) ?? []).map((w) => w.toUpperCase());
}

// ==================================================================== контент

describe("Пролог: контент дела", () => {
  it("мир сгенерирован быстро и один раз на файл", () => {
    expect(generationMs).toBeLessThan(10_000);
  });

  it("validateCaseContent → пусто", () => {
    expect(validateCaseContent(c00, characters, collectEvidenceIds(cases))).toEqual([]);
  });

  it("карточка дела по библии: 18:05, 1 мин/запрос, потолок 18:35, три таблицы", () => {
    expect(c00.order).toBe(0);
    expect(c00.act).toBe(1);
    expect(c00.difficulty).toBe("tutorial");
    expect(c00.date).toBe("2026-12-02 18:05");
    expect(c00.minutesPerQuery).toBe(1);
    expect(c00.clock?.cap).toBe("2026-12-02 18:35");
    expect(c00.tables).toEqual(["incidents", "staff", "transit_taps"]);
    expect(c00.newTables).toEqual(c00.tables);
    expect(c00.starterSql).toBe("SELECT * FROM incidents LIMIT 10;");
    expect(mainObjectives(c00).map((o) => o.id)).toEqual(["p1", "p2", "p3", "p3a", "p3b", "p4", "p5"]);
    expect(c00.objectives.filter((o) => o.optional).map((o) => o.id)).toEqual(["p4b"]);
    expect(c00.protocol?.batchSize).toBe(2);
  });

  it("у каждой задачи 4 подсказки голосами, улика и эталон; concept — статья справочника", () => {
    for (const o of c00.objectives) {
      expect(o.hints.length, o.id).toBe(4);
      for (const h of o.hints) expect(h.by, o.id).toBeDefined();
      if (!["p3a", "p3b"].includes(o.id)) expect(o.evidence?.id, o.id).toMatch(/^ev\.c00\./);
      expect(o.solution.trim(), o.id).not.toBe("");
      expect(handbookById.has(o.concept as string), o.id).toBe(true);
    }
    for (const id of c00.concepts) expect(handbookById.has(id), id).toBe(true);
  });

  it("реплики библии стоят на своих id", () => {
    const line = (id: string) => c00.scenes.flatMap((s) => s.lines).find((l) => l.id === id);
    expect(line("c00.desk.006")).toMatchObject({ speaker: "nina", text: "Это старьё из «Сокола», вечно сверху. Пролистывай, голубчик." });
    expect(line("c00.desk.011")).toMatchObject({ speaker: "tokha", text: "У нас каждое движение пишется. Даже твои запросы, хе." });
    expect(line("c00.close.004")).toMatchObject({ speaker: "ratnikov", text: "В штатке тебя нет. Будешь Ноль." });
    expect(line("c00.close.001")?.text).toBe("Нашли. Сидит на ступеньках, ест пирожок. Кто там у вас в подвале так быстро считает?");
    expect(line("c00.close.002")?.text).toBe("Ну вот. Ирочка тоже с потеряшек начинала.");
  });

  it("реплики озвучиваемы: ≤ 160 знаков, без цифр у персонажей; к игроку и у игрока — без родовых форм", () => {
    // \b в JS не видит кириллицу: границы слова — явные
    const END = "(?=$|[\\s.,!?…»:;)])";
    const youPast = new RegExp(`(^|[\\s,«(—])ты\\s+(\\S+\\s+)?[а-яё]+(л|ла|лся|лась)${END}`, "i");
    const iPast = new RegExp(`(^|[\\s,«(—])я\\s+(\\S+\\s+)?[а-яё]+(л|ла|лся|лась)${END}`, "i");
    const shortAdj = new RegExp(`(^|[\\s,«(—])(готов|готова|рад|рада|должен|должна|уверен|уверена)${END}`, "i");
    for (const scene of c00.scenes) {
      for (const l of scene.lines) {
        expect(l.text.length, l.id).toBeLessThanOrEqual(160);
        if (l.speaker !== "narrator") expect(/\d/.test(l.text), `${l.id}: цифры в озвучке`).toBe(false);
        expect(youPast.test(l.text), `${l.id}: «ты …л(а)»`).toBe(false);
      }
      for (const ch of scene.choices ?? []) {
        for (const re of [youPast, iPast, shortAdj]) expect(re.test(ch.text), ch.id).toBe(false);
      }
    }
    // проверка ловит то, что должна
    expect(youPast.test("Ты нашла его?")).toBe(true);
    expect(iPast.test("Я понял.")).toBe(true);
    expect(shortAdj.test("Я готова.")).toBe(true);
  });
});

// ==================================================================== эталоны

describe("Пролог: эталоны проходят по порядку", () => {
  it("каждый эталон засчитывает свою задачу через checkCaseProgress — на старте и на потолке часов", () => {
    for (const base of [db, dbCap]) {
      const completed = new Set<string>();
      for (const o of [...mainObjectives(c00), ...c00.objectives.filter((x) => x.optional)]) {
        const result = run(o.solution, base);
        expect(result.error, `${o.id}: ${result.error}`).toBeNull();
        const progress = checkCaseProgress(c00, result, base, completed);
        const ids = progress.completed.map((c) => c.objectiveId);
        expect(ids, o.id).toContain(o.id);
        // за один запрос — не больше одной основной задачи
        expect(ids.filter((id) => !objective(id).optional).length, o.id).toBeLessThanOrEqual(1);
        for (const id of ids) completed.add(id);
      }
      expect(isCaseObjectivesDone(c00, completed)).toBe(true);
    }
  });

  it("эталоны дают одинаковый результат на 18:05 и на 18:35", () => {
    for (const o of c00.objectives) {
      expect(run(o.solution, dbCap).rows, o.id).toEqual(run(o.solution, db).rows);
    }
  });

  it("эталоны проходят table-guard этого дела; закрытые таблицы — отказ", () => {
    for (const o of c00.objectives) {
      const r = executeSQL(db, o.solution, c00.tables);
      expect(r.error, o.id).toBeNull();
      expect(r.errorKind, o.id).toBeUndefined();
    }
    const denied = executeSQL(db, "SELECT * FROM persons WHERE id = 3612", c00.tables);
    expect(denied.error).not.toBeNull();
  });

  it("строгая лестница: в эталонах только SELECT, столбцы, WHERE, сравнения, AND, ORDER BY, LIMIT", () => {
    for (const o of c00.objectives) {
      const used = keywordsOf(o.solution).filter((w) => FUTURE_KEYWORDS.includes(w));
      expect(used, o.id).toEqual([]);
    }
  });

  it("каждый эталон выполняется быстрее 1 с и не больше 5 000 строк", () => {
    for (const o of c00.objectives) {
      const t0 = performance.now();
      const r = run(o.solution);
      expect(performance.now() - t0, o.id).toBeLessThan(1000);
      expect(r.rowCount, o.id).toBeLessThanOrEqual(5000);
      expect(r.truncated, o.id).toBeUndefined();
    }
  });
});

describe("Пролог: альтернативные формулировки засчитываются", () => {
  for (const [id, list] of Object.entries(ALTERNATIVES)) {
    it.each(list)(`${id}: %s`, (sql) => {
      expect(run(sql).error).toBeNull();
      expect(passes(id, sql)).toBe(true);
    });
  }
});

describe("Пролог: правдоподобные ошибки не засчитываются", () => {
  for (const [id, list] of Object.entries(MISTAKES)) {
    it.each(list)(`${id}: %s`, (sql) => {
      expect(passes(id, sql)).toBe(false);
    });
  }

  it("ошибок не меньше двух на задачу, альтернатив — не меньше одной", () => {
    for (const o of c00.objectives) {
      expect(MISTAKES[o.id]?.length ?? 0, o.id).toBeGreaterThanOrEqual(2);
      expect(ALTERNATIVES[o.id]?.length ?? 0, o.id).toBeGreaterThanOrEqual(1);
    }
  });

  it("последний уровень помощи даёт рабочее решение", () => {
    for (const o of c00.objectives) {
      const sheet = o.solution;
      expect(sheet, o.id).toBeDefined();
      expect(o.hints[3].text, o.id).toContain(sheet);
      expect(passes(o.id, sheet), o.id).toBe(true);
    }
  });

  it("ловушка пролога: '02.12.2026' — «>=» отдаёт весь журнал, «=» — ноль строк, линтер предупреждает", () => {
    const all = Number(one(db, "SELECT COUNT(*) FROM incidents"));
    expect(run("SELECT * FROM incidents WHERE reported_at >= '02.12.2026'").rowCount).toBe(all);
    expect(run("SELECT * FROM incidents WHERE reported_at = '02.12.2026'").rowCount).toBe(0);
    const warnings = lintSql("SELECT * FROM incidents WHERE reported_at >= '02.12.2026'", getSchema(db), { db });
    expect(warnings.map((w) => w.rule)).toContain("date_format");
  });

  it("примеры МИРЫ (уровень 2) — на других таблицах и столбцах, выполняются и сами задачу не решают", () => {
    const examples: [string, string][] = [
      ["p2", "SELECT full_name, position FROM staff"],
      ["p3", "SELECT * FROM staff WHERE hired_at >= '2026-01-01'"],
      ["p4", "SELECT full_name, hired_at FROM staff WHERE dept = 'ОЦР' ORDER BY hired_at DESC"],
      ["p5", "SELECT * FROM incidents WHERE district = 'Гавань'"],
      ["p4b", "SELECT * FROM incidents WHERE district = 'Гавань' AND kind = 'кража'"],
    ];
    for (const [id, sql] of examples) {
      expect(objective(id).hints[1].text, id).toContain(sql);
      const r = run(sql);
      expect(r.error, id).toBeNull();
      expect(r.rowCount, id).toBeGreaterThan(0);
      expect(passes(id, sql), id).toBe(false);
    }
  });

  it("P.2: звёздочка не проходит — сообщение про лишние столбцы", () => {
    expect(feedback("p2", "SELECT * FROM incidents LIMIT 10;")).toMatch(/Лишние столбцы/);
  });

  it("P.4: без DESC — «порядок не тот»", () => {
    expect(feedback("p4", MISTAKES.p4[0])).toMatch(/порядок/);
  });
});

// ==================================================================== протокол

describe("Пролог: протокол «Мальчик сейчас у …, сообщение получено …»", () => {
  const seenFromSolutions = () => {
    const protocol = c00.protocol as NonNullable<CaseDef["protocol"]>;
    const options = new Set<string>();
    const values = new Set<string>();
    for (const o of c00.objectives) {
      const r = run(o.solution);
      for (const v of scanSeenOptions(protocol, r)) options.add(v);
      for (const v of scanSeen(r)) values.add(v);
    }
    return { protocol, options, values };
  };

  it("ответы находятся scanSeenOptions в результатах эталонов (и именно в P.4)", () => {
    const { protocol, options } = seenFromSolutions();
    for (const blank of protocol.blanks) expect(options.has(blank.answer), blank.id).toBe(true);
    const p4 = scanSeenOptions(protocol, run(objective("p4").solution));
    expect(p4).toContain(C00_ANSWERS.place);
    expect(p4).toContain(C00_ANSWERS.time);
    expect(protocol.blanks.map((b) => b.answer)).toEqual([C00_ANSWERS.place, C00_ANSWERS.time]);
  });

  it("каждый вариант (в том числе ложный) можно увидеть в деле: банк слов не пустой", () => {
    const { protocol, values } = seenFromSolutions();
    for (const blank of protocol.blanks) {
      expect(availableOptions(blank, values), blank.id).toEqual(blank.options);
    }
  });

  it("верные ответы подтверждаются пачкой; один неверный — ничего не подтверждено", () => {
    const protocol = c00.protocol as NonNullable<CaseDef["protocol"]>;
    const ok = checkProtocol(protocol, { place: C00_ANSWERS.place, time: C00_ANSWERS.time }, new Set());
    expect(ok.solved).toBe(true);
    expect(ok.newlyConfirmed).toEqual(["place", "time"]);

    const wrongPlace = checkProtocol(protocol, { place: "Рынок, конечная маршрута № 3", time: C00_ANSWERS.time }, new Set());
    expect(wrongPlace.solved).toBe(false);
    expect(wrongPlace.newlyConfirmed).toEqual([]);

    const wrongTime = checkProtocol(protocol, { place: C00_ANSWERS.place, time: "2026-12-02 17:31:00" }, new Set());
    expect(wrongTime.newlyConfirmed).toEqual([]);

    const decoys = checkProtocol(protocol, { place: "Мостки у полыньи (Береговая)", time: "2026-12-02 17:44:00" }, new Set());
    expect(decoys.newlyConfirmed).toEqual([]);
  });

  it("время сверяется с точностью до минуты", () => {
    const time = (c00.protocol as NonNullable<CaseDef["protocol"]>).blanks.find((b) => b.id === "time");
    expect(time && isBlankCorrect(time, "2026-12-02 18:02")).toBe(true);
    expect(time && isBlankCorrect(time, "2026-12-02 18:02:00")).toBe(true);
    expect(time && isBlankCorrect(time, "2026-12-02 18:03:00")).toBe(false);
  });
});

// ==================================================================== посаженные факты

describe("Пролог: посаженные факты (разд. 8.4, блок «П»)", () => {
  it("вечер 02.12: ровно 14 вызовов с 16:00 — id 1701–1714, время, район и вид по библии", () => {
    const got = rows(world, "SELECT id, reported_at, district, kind, address_text FROM incidents WHERE reported_at >= '2026-12-02 16:00:00' AND reported_at <= '2026-12-02 18:35:00' ORDER BY id");
    expect(got).toEqual(EVENING_INCIDENTS.map((i) => [i.id, i.at, i.district, i.kind, i.address]));
    expect(got.map((r) => r[0])).toEqual(Array.from({ length: 14 }, (_, k) => 1701 + k));
  });

  it("с 18:02:01 до 18:35:00 вызовов нет — ответ P.3 не зависит от часов", () => {
    expect(one(world, "SELECT COUNT(*) FROM incidents WHERE reported_at > '2026-12-02 18:02:00' AND reported_at <= ?", [C00_QUIET_WINDOW.to])).toBe(0);
    expect(one(world, "SELECT COUNT(*) FROM incidents WHERE reported_at >= ? AND reported_at < '2026-12-02 16:12:00'", [C00_QUIET_WINDOW.from])).toBe(0);
  });

  it("сообщений граждан за вечер ровно 6; свежее — 1714, 18:02, «ДК «Полярник»»", () => {
    const got = rows(world, "SELECT id FROM incidents WHERE reported_at >= '2026-12-02 16:00:00' AND reported_at <= '2026-12-02 18:35:00' AND kind = 'сообщение гражданина' ORDER BY reported_at DESC");
    expect(got.map((r) => r[0])).toEqual([...CITIZEN_REPORTS_DESC]);
    expect(rows(world, "SELECT reported_at, address_text, description FROM incidents WHERE id = 1714")[0])
      .toEqual(["2026-12-02 18:02:00", "ДК «Полярник»", "Ребёнок в синем пуховике плачет на крыльце"]);
  });

  it("«ДК «Полярник»» — адрес ровно одного вызова во всём журнале", () => {
    expect(one(world, "SELECT COUNT(*) FROM incidents WHERE address_text = 'ДК «Полярник»'")).toBe(1);
  });

  it("папка дела ссылается на настоящий КУСП заявления 1702", () => {
    const kusp = Number(one(world, "SELECT kusp_no FROM incidents WHERE id = 1702"));
    expect(c00.briefing).toContain(`КУСП ${kusp}, 02.12.2026, 17:05`);
  });

  it("заявление 1702 (17:05): мать Лаптева Е. В., приметы; ложные следы 1705 и 1711; водитель 1709", () => {
    const r1702 = rows(world, "SELECT applicant_text, description FROM incidents WHERE id = 1702")[0];
    expect(r1702[0]).toBe("Лаптева Е. В.");
    for (const s of ["Миша, 8 лет", "синий пуховик", "рюкзак-кот"]) expect(String(r1702[1])).toContain(s);
    expect(String(one(world, "SELECT description FROM incidents WHERE id = 1705"))).toContain("Подросток на крыше гаражей");
    expect(rows(world, "SELECT district, description FROM incidents WHERE id = 1711")[0]).toEqual([
      "Створ", "Мальчик у полыньи с удочкой, на вид лет четырнадцать",
    ]);
    expect(String(one(world, "SELECT description FROM incidents WHERE id = 1709"))).toBe(
      "Водитель автобуса № 3: мальчик ехал один, вышел у остановки «ДК «Полярник»»"
    );
  });

  it("КУСП вечера растут вместе с id и уникальны в 2026 году", () => {
    const kusp = rows(world, "SELECT kusp_no FROM incidents WHERE id BETWEEN 1701 AND 1714 ORDER BY id").map((r) => Number(r[0]));
    expect(kusp).toEqual(EVENING_INCIDENTS.map((i) => i.kusp));
    for (let k = 1; k < kusp.length; k++) expect(kusp[k]).toBeGreaterThan(kusp[k - 1]);
    expect(Number(one(world, "SELECT kusp_no FROM incidents WHERE id = 1700"))).toBeLessThan(kusp[0]);
    expect(Number(one(world, "SELECT kusp_no FROM incidents WHERE id = 1715"))).toBeGreaterThan(kusp[13]);
    expect(one(world, `SELECT COUNT(*) FROM incidents WHERE reported_at LIKE '2026%' AND kusp_no IN (${kusp.join(",")})`)).toBe(14);
  });

  it("М1: запрос Нины на этой сборке отдаёт id 1–10; строка 7 — Ким С. А. и Бурцев В. Н., строка 6 — Сазонова В. С.", () => {
    const r = run("SELECT * FROM incidents LIMIT 10;");
    const idIdx = r.columns.indexOf("id");
    expect(r.rows.map((row) => row[idIdx])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const seven = rows(db, "SELECT reported_at, district, applicant_text, description, status, officer_staff_id FROM incidents WHERE id = 7")[0];
    expect(seven.slice(0, 3)).toEqual(["2015-02-19 23:58:00", "Створ", "Ким С. А. (Береговая, 4)"]);
    expect(String(seven[3])).toContain("ст. наряда Бурцев В. Н.");
    expect(seven.slice(4)).toEqual(["приостановлено", F.STAFF.ratnikov]);
    expect(rows(db, "SELECT reported_at, applicant_text FROM incidents WHERE id = 6")[0]).toEqual(["2015-02-19 23:20:00", "Сазонова В. С."]);
  });

  it("transit_taps: ровно одна посадка Лаптева М. А. — 16:41:00, Ш-00417, маршрут 3, «Музыкальная школа»", () => {
    expect(rows(world, "SELECT ts, card_no, card_kind, holder_text, route, stop FROM transit_taps WHERE holder_text = 'Лаптев М. А.'"))
      .toEqual([[SCHOOL_CARD.ts, SCHOOL_CARD.cardNo, SCHOOL_CARD.kind, SCHOOL_CARD.holder, SCHOOL_CARD.route, SCHOOL_CARD.stop]]);
    expect(one(world, "SELECT COUNT(*) FROM transit_taps WHERE card_no = 'Ш-00417'")).toBe(1);
    expect(one(world, "SELECT COUNT(*) FROM transit_taps")).toBe(300);
    expect(one(world, "SELECT COUNT(*) FROM transit_taps WHERE ts < '2026-12-02 15:00:00' OR ts > ?", [F.CASE_START.c00])).toBe(0);
  });

  it("staff 118 — Ирина; staff 151 — игрок (патч p0.player); за WS-03 ровно они двое", () => {
    expect(rows(db, "SELECT person_id, full_name, login, position, dept, workstation, badge_id, hired_at, fired_at FROM staff WHERE id = 118")[0])
      .toEqual([4127, "Вальц И. П.", "i.valts", "аналитик ОЦР", "ОЦР", "WS-03", "B-4127", "2025-03-03", "2026-11-19"]);
    expect(rows(db, "SELECT person_id, full_name, login, position, dept, workstation, badge_id, hired_at, fired_at, contract_no FROM staff WHERE id = 151")[0])
      .toEqual([9000, PLAYER_NAME, "nol", "аналитик ОЦР (подрядчик)", "ОЦР", "WS-03", "B-9000", "2026-12-02", null, "ТБ-2026/117"]);
    expect(rows(db, "SELECT id FROM staff WHERE workstation = 'WS-03' ORDER BY id").map((r) => r[0])).toEqual([118, 151]);
    expect(one(db, "SELECT COUNT(*) FROM staff WHERE login = 'nol'")).toBe(1);
    // без патча игрока в мире нет: P.5 решается только после старта пролога
    expect(one(world, "SELECT COUNT(*) FROM staff WHERE id = 151 OR badge_id = 'B-9000'")).toBe(0);
  });

  it("мать и мальчик — жители 3611 / 3612", () => {
    expect(rows(world, "SELECT id, full_name, birth_date FROM persons WHERE id IN (3611, 3612) ORDER BY id")).toEqual([
      [3611, "Лаптева Елена Викторовна", "1990-10-02"],
      [3612, "Лаптев Михаил Андреевич", "2018-03-09"],
    ]);
  });
});

// ==================================================================== тайники

describe("Пролог: тайники не меняют ответов", () => {
  it("«Кот Шрёдингера» (льготные карты) не засчитывает ★, «Совы» не засчитывают P.3 и P.4", () => {
    expect(passes("p4b", "SELECT ts, card_no, holder_text, route, stop FROM transit_taps WHERE card_kind = 'льготная' ORDER BY ts LIMIT 20;")).toBe(false);
    const owls = "SELECT id, reported_at, kind, description, applicant_text FROM incidents WHERE district = 'Промзона' AND reported_at >= '2026-10-24 00:00:00' AND reported_at <= '2026-10-25 23:59:59';";
    expect(passes("p3", owls)).toBe(false);
    expect(passes("p4", owls)).toBe(false);
  });
});
