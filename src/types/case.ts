/**
 * Контракт контента v2: дело (кейс), его задачи, протокол-дедукция,
 * улики и доска, обвинение, живые события, игровые часы, справочник,
 * тайники (пасхалки) и достижения.
 *
 * Контент хранится в JSON:
 *   src/data/characters.json          — CharacterDef[]
 *   src/data/handbook.json            — HandbookEntry[]
 *   src/data/secrets.json             — SecretDef[]
 *   src/data/cases/<id>/case.json     — CaseDef без scenes
 *   src/data/cases/<id>/script.json   — { scenes: Scene[] }
 *
 * Новые поля необязательны: контент можно дописывать постепенно.
 */
import type { CellValue, ValidationRule } from "./mission";
import type { Scene } from "./story";

export type Difficulty = "tutorial" | "easy" | "medium" | "hard" | "expert";

export type EvidenceKind = "document" | "record" | "photo" | "audio" | "testimony" | "lead";

export interface EvidenceDef {
  /** Уникален в пределах сезона: ev.<cNN>.<slug> */
  id: string;
  title: string;
  text: string;
  kind: EvidenceKind;
}

export interface HintDef {
  text: string;
  /** id персонажа, который даёт подсказку (подсказки звучат голосами героев) */
  by?: string;
  /** id озвученной реплики наводки: hint.<cNN>_<id задачи>.<nnn> (разд. 11.3) */
  line?: string;
}

// --- Сюжетные флаги ---

/** Значение сюжетного флага: доверие (число), выбор (строка), факт (булево) */
export type FlagValue = string | number | boolean;

/**
 * Условие на сюжетные флаги: все пары должны выполняться. Отсутствующий флаг
 * равен false (и null). Массив — любое из значений:
 * `{ "tokha_turned": false }`, `{ "melnik": [null, "blackmail"] }`.
 */
export type FlagCondition = Record<string, FlagValue | null | Array<FlagValue | null>>;

// --- Предсказание ---

/**
 * «Сколько строк вернёт запрос?» (разд. 4.2, 6.3): три варианта перед
 * ключевым запросом. Верный ответ — +10 к мастерству понятия.
 */
export interface PredictionDef {
  /** Вопрос: «Сколько строк вернёт JOIN по КУСП 4515?» */
  question: string;
  /** Запрос, о котором спрашивают (показывается игроку); не задан — эталон задачи */
  sql?: string;
  /** Ровно три варианта — числа строк */
  options: number[];
  /** Верный вариант — один из options; тест дела сверяет его с числом строк sql/solution */
  answer: number;
  /** Пояснение после ответа (МИРА) */
  explanation?: string;
}

export interface CaseObjective {
  /** Уникален в пределах дела: [a-z0-9_-]+ (p1, o5_1, o10_2b, i1) */
  id: string;
  /** Порядок выполнения основных задач */
  order: number;
  /** Формулировка задачи внутри мира */
  task: string;
  /** Рабочая основа для небольшой правки; вставляется только по желанию игрока. */
  scaffoldSql?: string;
  /** id статьи справочника, которую отрабатывает задача */
  concept?: string;
  /** Проверка результата запроса — любой корректный запрос засчитывается */
  validation: ValidationRule;
  /** Уровни подсказок: намёк → концепция → шаблон → рабочий пример */
  hints: HintDef[];
  /** Вывод/реплика после выполнения */
  success: string;
  /** Карточка улики, которую получает игрок */
  evidence?: EvidenceDef;
  /** Сцена, которая проигрывается после выполнения */
  sceneAfter?: string;
  /** Дополнительная задача: не блокирует дело, проверяется на каждом запросе */
  optional?: boolean;
  /**
   * Задача существует только при этих флагах (условные задачи: 10.2б —
   * `{ "tokha_turned": false }`). Если условие ложно, задача не активна и
   * не нужна для закрытия дела.
   */
  when?: FlagCondition;
  /** Предсказание числа строк перед ключевым запросом этой задачи */
  prediction?: PredictionDef;
  /**
   * Эталонное решение: тесты, автопрохождение и явная вставка последнего уровня помощи.
   */
  solution: string;
}

// --- Протокол ---

/**
 * Тип пропуска протокола (разд. 6.4):
 *  - person — человек: подходит увиденное ФИО или увиденный persons.id (через aliases);
 *  - number — число: увиденные числовые ячейки и числа строк, сравнение по модулю с допуском;
 *  - datetime — дата или момент: сравнение по префиксу точности;
 *  - text — всё остальное: точное совпадение после нормализации.
 */
export type BlankKind = "person" | "number" | "datetime" | "text";

/** Точность сравнения дат: префикс 'YYYY-MM-DD' / '… HH' / '… HH:MM' / '… HH:MM:SS' */
export type DatetimePrecision = "day" | "hour" | "minute" | "second";

export interface ProtocolBlank {
  id: string;
  /** Тип пропуска: как ищется в результатах и как сверяется ответ */
  kind: BlankKind;
  /** Варианты в выпадающем списке (включая ложные). Для person — persons.full_name */
  options: string[];
  /** Верный вариант — один из options, точной строкой ячейки */
  answer: string;
  /**
   * Другие увиденные значения, которые открывают вариант: ключ — вариант из
   * options. Для person — persons.id, full_name_text морга, owner_name
   * реестра машин: `{ "Вальц Ирина Петровна": [4127] }`.
   */
  aliases?: Record<string, Array<string | number>>;
  /** number: допуск сравнения по модулю (по умолчанию 0.01) */
  tolerance?: number;
  /** datetime: точность сравнения (по умолчанию — точность, с которой записан answer) */
  precision?: DatetimePrecision;
  /**
   * Вариант можно выбрать, только если игрок видел это значение в
   * результатах своих запросов в этом деле (по умолчанию true).
   * Обвинять можно только тех, кого нашёл сам.
   */
  requireSeen?: boolean;
}

export interface ProtocolDef {
  /** Строки протокола с пропусками вида {blankId} */
  statements: string[];
  blanks: ProtocolBlank[];
  /**
   * Пакетное подтверждение как в Return of the Obra Dinn: верные пропуски
   * подтверждаются, только когда верных среди ещё не подтверждённых не меньше
   * batchSize (или все оставшиеся верны). По умолчанию 3, в прологе 2.
   */
  batchSize?: number;
  /** Сцена после полного подтверждения протокола */
  successScene: string;
  /** Реплики-реакции на неудачную сверку (выбираются по кругу) */
  failureLines?: string[];
}

// --- Карточки улик и доска (разд. 6.5) ---

/** Класс источника карточки: два разных класса подтверждают узел доски */
export type SourceClass =
  | "pbd"
  | "sokol_2016"
  | "mirror_siyanie"
  | "mirror_city"
  | "dorset"
  | "operator"
  | "bank"
  | "gs_archive"
  | "carbon"
  | "witness"
  | "hydropost";

/** Подписи классов источников для карточек */
export const SOURCE_CLASS_LABELS: Record<SourceClass, string> = {
  pbd: "ПБД",
  sokol_2016: "Сокол-2016",
  mirror_siyanie: "ЗЕРКАЛО: Сияние",
  mirror_city: "ЗЕРКАЛО: город",
  dorset: "Дорсеть",
  operator: "оператор",
  bank: "банк",
  gs_archive: "архив ГС",
  carbon: "копирка",
  witness: "свидетель",
  hydropost: "гидропост",
};

/**
 * Штамп карточки (разд. 9.6): СВЕРЕНО, РАСХОЖДЕНИЕ, ПРИЗРАК, ПОДЛОГ.
 * Карточки с mismatch / ghost / forgery не считаются источником.
 */
export type CardStamp = "verified" | "mismatch" | "ghost" | "forgery";

/** Приколотая карточка: одна строка результата или однострочный агрегат */
export interface PinnedCard {
  id: string;
  columns: string[];
  values: CellValue[];
  /** Таблица-источник */
  table?: string;
  sourceClass?: SourceClass;
  /** Узел доски, к которому карточку отнёс игрок */
  node?: string;
  /** Запрос, которым получена строка */
  sql?: string;
  /** Игровое время пина 'YYYY-MM-DD HH:MM:SS' */
  pinnedAt?: string;
  /** Отпечаток значений — для перепроверки */
  fingerprint?: string;
  stamp?: CardStamp;
}

/**
 * Условие на ячейку карточки. Все заданные операторы должны выполниться на
 * одной ячейке; column не задан — подходит любой столбец.
 */
export interface CardCondition {
  /** Имя столбца карточки (без регистра) или несколько вариантов имени */
  column?: string | string[];
  /** Равно (числа — с допуском tolerance, строки — после нормализации) */
  eq?: CellValue;
  /** Одно из значений */
  in?: CellValue[];
  /** Начинается с (без регистра; удобно для дат: '2026-11-18 23') */
  prefix?: string;
  /** Содержит подстроку (без регистра, ё = е) */
  contains?: string;
  /** Диапазон включительно: числа или строки ISO */
  between?: [CellValue, CellValue];
  /** Допуск для eq/in с числами (по умолчанию 0.01) */
  tolerance?: number;
}

/**
 * Предикат над карточкой — «узел доски»: `plate = 'К404ТО' AND read_at BETWEEN …`.
 * Карточка засчитывается по содержимому, а не по id строки или запросу.
 */
export interface CardPredicate {
  /** Все условия выполняются */
  all?: CardCondition[];
  /** Хотя бы одно условие выполняется */
  any?: CardCondition[];
  /** Таблица-источник (одна из) */
  table?: string | string[];
  /** Класс источника (один из) */
  sourceClass?: SourceClass | SourceClass[];
  /** Узел доски */
  node?: string;
}

// --- Обвинение (разд. 6.8) ---

export interface AccusationDef {
  /** Уникален в пределах дела */
  id: string;
  /** Формулировка: «Под логином i.valts работал …» */
  prompt: string;
  /** Верный обвиняемый — persons.full_name, как его видит игрок в поиске по увиденным */
  answer: string;
  /**
   * Ключи обвиняемого, по которым засчитываются карточки: persons.id, логин,
   * пропуск, номер машины. Карточка подходит, если в ней есть хотя бы один ключ.
   */
  keys: Array<string | number>;
  /** Сколько карточек с ключами приложить (по умолчанию 2) */
  minCards?: number;
  /** Сцена при верном обвинении */
  successScene: string;
  /** Реакции на ложные обвинения конкретных людей (по full_name) */
  wrong?: Array<{ person: string; scene: string }>;
  /** Сцена на любое другое ложное обвинение */
  wrongScene: string;
  /** Флаг доверия, который уменьшается на 1 при ложном обвинении (dasha_trust) */
  trustFlag?: string;
  /** Задача дела, которую закрывает верное обвинение */
  objective?: string;
  /**
   * Без принятого обвинения дело не закрывается, даже если все основные задачи
   * выполнены (Д8: после 8.4 — обвинение, допрос Тохи и кода).
   */
  required?: boolean;
}

// --- Живые события и часы (разд. 6.10) ---

/**
 * Сюжетный триггер: все заданные поля должны выполняться.
 *  - objective — задача засчитана;
 *  - scene — сцена доиграна до конца (`scene_end`);
 *  - interrogation + breaks — на допросе в сцене сделано не меньше breaks пробоев (по умолчанию 1);
 *  - flag (+ value) — флаг выставлен (или равен value).
 */
export interface EventTrigger {
  objective?: string;
  scene?: string;
  interrogation?: string;
  breaks?: number;
  flag?: string;
  value?: FlagValue;
}

/**
 * Живое событие дела. Срабатывает один раз по одному из триггеров: на N-м
 * запросе, когда часы дошли до момента, или после сюжетного события.
 * Эффекты: сцена, сюжетный патч мира, реплика, перевод часов.
 */
export interface LiveEventDef {
  /** Уникален в пределах дела */
  id: string;
  /** N-й запрос дела, двигающий часы (счёт с 1) */
  atQuery?: number;
  /** Момент игровых часов 'YYYY-MM-DD HH:MM[:SS]' */
  atTime?: string;
  /** Сюжетный триггер */
  after?: EventTrigger;
  /** Событие только при этих флагах (удаления при melnik = blackmail) */
  when?: FlagCondition;
  /** Сцена, которая проигрывается */
  scene?: string;
  /** id сюжетного патча мира (вставка строк, чистка, удаление таблицы) */
  patch?: string;
  /** Реплика без сцены: bark.* / sys.* */
  line?: string;
  /** Перевести часы на этот момент, если они показывают меньше (чистка в Д10) */
  clockTo?: string;
}

/**
 * Остановка часов: часы стоят на `at`, пока не выполнен триггер `until`.
 * Д5: стоят на 03:11 до задачи 5.1, первый запрос после неё — 03:12:30 (resumeAt).
 */
export interface ClockHold {
  at: string;
  until: EventTrigger;
  /** После выполнения триггера часы перескакивают сюда, если стояли на `at` */
  resumeAt?: string;
  /** Только в режиме доступности «Без таймера» */
  noTimerOnly?: boolean;
}

/** Часы дела: старт, потолок и остановки. Минуты за запрос — CaseDef.minutesPerQuery */
export interface CaseClockDef {
  /** Старт часов 'YYYY-MM-DD HH:MM[:SS]' (по умолчанию CaseDef.date) */
  start?: string;
  /** Потолок: дойдя до него, часы встают */
  cap?: string;
  holds?: ClockHold[];
}

// --- Контекст проверки ---

/**
 * Состояние стола, которое нужно новым правилам валидации (pin, seen, slot)
 * и условным задачам (flags). Передаётся четвёртым аргументом в validate()
 * и checkCaseProgress(); без него эти правила не проходят.
 */
export interface ValidationContext {
  /** Карточки на доске */
  pins?: readonly PinnedCard[];
  /** Реестр увиденного: значения ячеек и числа строк (scanSeen) */
  seen?: ReadonlySet<string>;
  /** Слоты: пропуски протокола и слоты доски («Перекрыть») — id → значение */
  slots?: Readonly<Record<string, string | undefined>>;
  /** Сюжетные флаги */
  flags?: Readonly<Record<string, FlagValue>>;
}

export interface CaseDef {
  /** case-NN-<slug>, NN = order: case-00-nulevoy-etazh … case-11-chernovik, case-12-pervoe-solntse */
  id: string;
  order: number;
  act: number;
  /** «Дело № 03» */
  code: string;
  title: string;
  subtitle: string;
  /** Внутриигровое время начала: 'YYYY-MM-DD HH:MM[:SS]' (секунды по умолчанию 00) */
  date: string;
  /** Минут игрового времени за запрос (по умолчанию 1; 0 — время двигают только сцены) */
  minutesPerQuery?: number;
  /** Часы дела: старт, потолок, остановки */
  clock?: CaseClockDef;
  location?: string;
  difficulty: Difficulty;
  /** Новые статьи справочника, которые открывает дело */
  concepts: string[];
  /** Все доступные таблицы (кумулятивно) */
  tables: string[];
  /** Таблицы, открытые именно в этом деле (подсвечиваются) */
  newTables?: string[];
  /**
   * Белый список записи (разд. 6.14, п. 5): INSERT/UPDATE/DELETE/REPLACE
   * только в эти таблицы, плюс BEGIN/COMMIT/ROLLBACK. Каждая должна входить
   * в tables. Не задан или пуст — архив только для чтения.
   */
  writableTables?: string[];
  /** Разрешить CREATE VIEW / DROP VIEW своих представлений (И и Д11). Другой DDL запрещён всегда */
  allowViews?: boolean;
  /** Лимит запросов (давление в финале); не задан — без лимита */
  queryBudget?: number;
  /** Текст папки дела */
  briefing: string;
  starterSql?: string;
  /** Сцена при открытии дела */
  introScene: string;
  objectives: CaseObjective[];
  /** Протокол-дедукция; если нет — дело закрывается по выполнению задач */
  protocol?: ProtocolDef;
  /** Обвинения свободным поиском (Д8, Д11) */
  accusations?: AccusationDef[];
  /** Живые события по счётчику запросов, часам и сюжетным триггерам */
  events?: LiveEventDef[];
  /** Финальная сцена, если нет протокола */
  outroScene?: string;
  /** Сцены из script.json */
  scenes: Scene[];
}

export interface HandbookEntry {
  id: string;
  title: string;
  /** Суть в одном-двух предложениях */
  summary: string;
  /** Шаблон синтаксиса */
  syntax: string;
  /** Пример на данных мира */
  example: string;
  /** Частые ошибки и нюансы SQLite */
  pitfalls?: string[];
}

export interface SecretDef {
  /** secret.<slug> */
  id: string;
  title: string;
  /** Записка, которая открывается при находке */
  text: string;
  /** Срабатывает, когда результат любого запроса проходит это правило */
  trigger: ValidationRule;
  /** Таблицы, без доступа к которым тайник не найти (для подсказки в коллекции) */
  tables?: string[];
}

export type AchievementKind =
  | "case_solved"
  | "case_no_hints"
  | "case_three_stars"
  | "protocol_first_try"
  | "secrets_found"
  | "all_optional"
  | "season_complete"
  /** Сюжетный флаг поднят: param — имя флага (tokha_turned, ending_first_sun…) */
  | "flag"
  /** Счётчик дошёл до порога: param — «имя:порог» (notes_heard:10, endings_seen:5, ficus_pets:10) */
  | "counter"
  /**
   * Событие случилось хотя бы раз: param — id события. Стор порождает общие события:
   * first_query, query_timeout, solved_after_midnight, future_concept,
   * objective_done:<caseId>/<objectiveId>, objective_first_try:<caseId>/<objectiveId>,
   * objective_no_hint:<caseId>/<objectiveId>, а также сюжетные события дел.
   */
  | "event";

export interface AchievementDef {
  id: string;
  title: string;
  description: string;
  kind: AchievementKind;
  /** Параметр условия: id дела, нужное количество, имя флага/счётчика или id события (см. AchievementKind) */
  param?: string | number;
  /** Скрыто до получения */
  hidden?: boolean;
}
