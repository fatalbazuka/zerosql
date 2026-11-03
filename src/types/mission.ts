import type { QueryResult } from "./database";
import type { BlankKind, CardPredicate, DatetimePrecision } from "./case";

export type CellValue = string | number | null;

export type ValidationRule =
  | { type: "row_count"; expected: number; comparison: "eq" | "gte" | "lte" }
  | { type: "contains_columns"; columns: string[] }
  | { type: "contains_value"; column: string; value: unknown }
  | { type: "exact_match"; referenceQuery: string }
  | { type: "custom"; check: (result: QueryResult) => ValidationOutcome }
  | { type: "requires_column"; column: string; minRows?: number }
  | { type: "contains_substring"; column: string; substring: string }
  | { type: "value_check"; row: number; col: number; comparison: "eq" | "gt" | "gte" | "lt" | "lte"; expected: number }
  | { type: "compound"; rules: ValidationRule[]; successMessage: string }
  | { type: "any_of"; rules: ValidationRule[]; successMessage: string }
  /**
   * Любая ячейка результата (или ячейка одного из перечисленных столбцов) равна value.
   * Числа сравниваются с допуском tolerance (по умолчанию 0.01), строки — без учёта регистра.
   */
  | { type: "cell_value"; value: CellValue; columns?: string[]; tolerance?: number }
  /**
   * Значения столбца совпадают с эталоном (списком values или первым столбцом referenceQuery).
   * Столбец ищется по именам из columns; если ни одно имя не найдено — по содержимому любого столбца.
   * mode: equal — те же значения; superset — эталон входит в результат; subset — результат входит в эталон.
   * ordered: сравнивать последовательность (для заданий на ORDER BY).
   */
  | {
      type: "column_values";
      columns?: string[];
      values?: CellValue[];
      referenceQuery?: string;
      mode?: "equal" | "superset" | "subset";
      ordered?: boolean;
    }
  /**
   * Строки совпадают с эталонным запросом по его столбцам. Лишние столбцы игрока допустимы.
   * Столбец эталона ищется в результате игрока по имени (или алиасам), затем — по совпадению значений.
   */
  | { type: "rows_match"; referenceQuery: string; ordered?: boolean; aliases?: Record<string, string[]> }
  /** Инверсия правила — например, «в результате не должно быть ложного следа» */
  | { type: "not"; rule: ValidationRule; message: string }
  /**
   * Состояние базы после DML игрока: движок выполняет query (на том же снимке
   * горизонта) и проверяет ЕГО результат правилом rule. Результат игрока не важен.
   * Пример: `{ query: "SELECT COUNT(*) FROM arch16_statements a WHERE a.id NOT IN (SELECT id FROM statements)", rule: { type: "cell_value", value: 0 } }`.
   */
  | { type: "table_state"; query: string; rule: ValidationRule }
  /**
   * Содержимое представления игрока: view существует (CREATE VIEW) и его строки
   * совпадают с referenceQuery (как rows_match) и/или проходят rule.
   */
  | { type: "view_match"; view: string; referenceQuery?: string; ordered?: boolean; rule?: ValidationRule }
  /**
   * На доске не меньше min карточек (по умолчанию 1), подходящих под предикат,
   * из не меньше sources разных классов источников. Призраки, расхождения и
   * подлоги не считаются, если не включить includeGhosts.
   */
  | {
      type: "pin";
      where: CardPredicate;
      min?: number;
      sources?: number;
      includeGhosts?: boolean;
      message?: string;
    }
  /** Значение есть в реестре увиденного (сравнение по правилам типа пропуска, по умолчанию text) */
  | {
      type: "seen";
      value: CellValue;
      kind?: BlankKind;
      tolerance?: number;
      precision?: DatetimePrecision;
      message?: string;
    }
  /** Слот протокола или доски заполнен одним из значений (по правилам типа, по умолчанию text) */
  | {
      type: "slot";
      slot: string;
      value: CellValue | CellValue[];
      kind?: BlankKind;
      tolerance?: number;
      precision?: DatetimePrecision;
      message?: string;
    };

export interface ValidationOutcome {
  passed: boolean;
  message: string;
  /** Проверка не может сделать вывод; отрицание не должно превращать её в успех. */
  inconclusive?: boolean;
}
