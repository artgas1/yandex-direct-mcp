import { callDirect, type Units } from './http.js';

/**
 * Служба отчётов — единственная в Директе, живущая по другим правилам.
 *
 * Что снято прогоном живого API и на чём стоит этот модуль:
 *
 * • ТЕЛО БЕЗ `method`. У всех прочих служб тело — `{method, params}`, здесь
 *   только `{params}`. Лишний ключ `method` запрос ломает.
 *
 * • ОТВЕТ ПРИХОДИТ НЕ СРАЗУ. Замер: запрос 1 → HTTP 201 и `retryIn: 1`;
 *   запрос 2 → HTTP 202 и `retryIn: 10`; запрос 3 → HTTP 200 и готовая выгрузка.
 *   Повторять надо ТЕМ ЖЕ `ReportName`: имя и есть ключ поставленной задачи.
 *   Синхронный вызов на большом окне отдаёт 504, а не данные.
 *
 * • ДЕНЬГИ ПО УМОЛЧАНИЮ В МИКРО-ЕДИНИЦАХ, и это главная ловушка всего API.
 *   Один и тот же отчёт по одной кампании: без заголовка — `Cost 1234500000`,
 *   с `returnMoneyInMicros: false` — `1234.50`. Это одна и та же сумма.
 *   Ошибка здесь ровно в миллион раз, и она не выглядит ошибкой: 1234500000 —
 *   правдоподобное число, его можно сложить, поделить и построить по нему график.
 *   Поэтому заголовок задаётся ПРИНУДИТЕЛЬНО и не выносится в параметры
 *   инструмента: возможность попросить микро-единицы — это возможность
 *   получить неверный ответ молча.
 *
 * • ПРОПУСК ОБОЗНАЧАЕТСЯ `--`, а не пустой ячейкой и не нулём. В замере он стоял
 *   в `AdGroupId` у Мастера кампаний. Прочитанный как число, он даёт NaN, а
 *   прочитанный как строка — уезжает в отчёт видом «группа с именем --».
 */

/** Пропуск значения в выгрузке. Не ноль и не пустая строка. */
export const MISSING = '--';

export interface ReportRequest {
  params: Record<string, unknown>;
  token: string;
  clientLogin?: string;
  /** Потолок ожидания. Отчёт на квартал в замере занял три запроса. */
  maxWaitMs?: number;
}

export interface ReportResult {
  columns: string[];
  rows: Array<Record<string, string | number | null>>;
  /** Сколько раз пришлось спросить, прежде чем отчёт был готов. */
  polls: number;
  units: Units | null;
  /** Строк отдано против строк в отчёте: усечение называется вслух. */
  totalRows: number;
  returnedRows: number;
}

/**
 * Заголовки, которые задаём сами и не даём переопределить.
 * `returnMoneyInMicros: false` — по причине выше; `skipReportHeader` и
 * `skipReportSummary` убирают строки, которые ломают разбор таблицы.
 */
function reportHeaders(mode: string): Record<string, string> {
  return {
    processingMode: mode,
    returnMoneyInMicros: 'false',
    skipReportHeader: 'true',
    skipReportSummary: 'true',
    skipColumnHeader: 'false',
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Сколько ждать перед повтором: Директ сам говорит это заголовком `retryIn`. */
function retryDelayMs(headers: Headers, fallbackSeconds: number): number {
  const raw = Number(headers.get('retryIn'));
  const seconds = Number.isFinite(raw) && raw > 0 ? raw : fallbackSeconds;
  return Math.min(seconds, 60) * 1000;
}

export async function runReport({
  params,
  token,
  clientLogin,
  maxWaitMs = 300_000,
}: ReportRequest): Promise<{ tsv: string; polls: number; units: Units | null }> {
  const started = Date.now();
  let polls = 0;

  for (;;) {
    polls++;
    const res = await callDirect({
      service: 'reports',
      params,
      token,
      clientLogin,
      headers: reportHeaders('auto'),
    });

    // 200 — отчёт готов. 201 и 202 — поставлен в очередь и считается; тела у них
    // нет, и принять их за пустой отчёт означает молча отдать ноль строк.
    if (res.httpStatus === 200) {
      return { tsv: res.raw, polls, units: res.units };
    }

    if (res.httpStatus !== 201 && res.httpStatus !== 202) {
      throw new Error(
        `отчёт вернул неожиданный статус ${res.httpStatus}. Ожидались 200 (готов), ` +
          '201 (поставлен в очередь) или 202 (считается).',
      );
    }

    if (Date.now() - started > maxWaitMs) {
      throw new Error(
        `отчёт не готов за ${Math.round(maxWaitMs / 1000)} с (запросов: ${polls}, последний статус ` +
          `${res.httpStatus}). Он не потерян: повторите вызов с тем же ReportName — ` +
          'имя отчёта и есть ключ поставленной задачи.',
      );
    }

    await sleep(retryDelayMs(res.headers, res.httpStatus === 201 ? 1 : 10));
  }
}

/**
 * Разбор выгрузки. Числовые колонки приводятся к числам, `--` становится null —
 * именно null, а не ноль: «показов не было» и «значение неприменимо» это разные
 * утверждения, и складывать второе с первым нельзя.
 */
export function parseTsv(
  tsv: string,
  limit: number,
): { columns: string[]; rows: ReportResult['rows']; totalRows: number } {
  const lines = tsv.split('\n').filter((l) => l.length > 0);
  const columns = (lines.shift() ?? '').split('\t');
  const totalRows = lines.length;
  const rows = lines.slice(0, limit).map((line) => {
    const cells = line.split('\t');
    const row: Record<string, string | number | null> = {};
    columns.forEach((col, i) => {
      const cell = cells[i];
      if (cell === undefined || cell === MISSING) {
        row[col] = null;
        return;
      }
      // Число распознаём строго: строка обязана быть числом целиком, иначе
      // «2026-08-01» частично разберётся в 2026 и станет годом.
      row[col] = /^-?\d+(\.\d+)?$/.test(cell) ? Number(cell) : cell;
    });
    return row;
  });
  return { columns, rows, totalRows };
}

export function countRows(tsv: string): number {
  const lines = tsv.split('\n').filter((l) => l.length > 0);
  return Math.max(lines.length - 1, 0);
}
