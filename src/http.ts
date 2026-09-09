import { parseExact } from './json.js';

/**
 * Транспорт к API Яндекс Директа v5.
 *
 * Каждый инвариант здесь стоит на замере живого кабинета, а не на
 * чтении документации. Перечислены они потому, что все четыре нарушаются
 * «естественной» реализацией на fetch, и ни одно нарушение не видно по выводу.
 *
 * 1. УСПЕХ ОПРЕДЕЛЯЕТСЯ ТЕЛОМ, А НЕ СТАТУСОМ. Ошибка приезжает с HTTP 200
 *    (неверный FieldNames → error_code 8000) и с HTTP 202 (неизвестный метод →
 *    error_code 55, воспроизведено дважды). Проверка `res.ok` пропускает обе:
 *    отказ уходит модели как удачный ответ. Признак отказа ровно один — ключ
 *    `error` в теле.
 *
 * 2. ТОТ ЖЕ КОД 202 ЗНАЧИТ РАЗНОЕ. У `campaigns` он принёс ошибку, у `reports`
 *    означает «отчёт ещё считается». Поэтому статус трактуется в контексте
 *    сервиса, а не единой таблицей.
 *
 * 3. ТОЧНОСТЬ. Разбор идёт через parseExact: `JSON.parse` портит идентификаторы
 *    объявлений (см. json.ts).
 *
 * 4. ДЕНЬГИ. В json v5 суммы приходят в микро-единицах всегда: `DailyBudget.Amount`
 *    1000000000 — это 1000 единиц валюты счёта. В отчётах то же самое, но там это отключается
 *    заголовком, и он задаётся принудительно (см. reports.ts).
 */

export const API_HOST = 'https://api.direct.yandex.com';
export const SANDBOX_HOST = 'https://api-sandbox.direct.yandex.com';

export type ApiVersion = 'v501' | 'v5';
export const DEFAULT_VERSION: ApiVersion = 'v501';

/**
 * Версия пути. Не косметика и не вкусовщина — она МЕНЯЕТ ДАННЫЕ.
 *
 * Один и тот же запрос к одному кабинету:
 *   /json/v5/campaigns   → N кампаний, у всех Type = TEXT_CAMPAIGN
 *   /json/v501/campaigns → те же N,    у всех Type = UNIFIED_CAMPAIGN
 *
 * И это не переименование значения, а разные представления, у которых разные
 * наборы глубоких полей:
 *
 *   v5   + TextCampaignFieldNames     → приходит TextCampaign
 *   v5   + UnifiedCampaignFieldNames  → НЕ ПРИХОДИТ НИЧЕГО, и без ошибки
 *   v501 + TextCampaignFieldNames     → НЕ ПРИХОДИТ НИЧЕГО, и без ошибки
 *   v501 + UnifiedCampaignFieldNames  → приходит UnifiedCampaign
 *
 * То есть несовпадение версии и набора полей отнимает стратегию, настройки и
 * счётчики МОЛЧА: ответ успешен, кампания на месте, просто глубоких полей в ней
 * нет. Прочитать это можно только как «у кампании ничего не настроено».
 * Поэтому версия выбирается явно, называется в ответе и учитывается при сборке
 * имён глубоких наборов полей (см. fieldGroupFor).
 *
 * Умолчание — v501: текущая документация называет адресом запросов только его
 * (90 вхождений против нуля у /json/v5/) и требует его для Единой
 * перфоманс-кампании и товарных объявлений.
 */
export function apiVersion(): ApiVersion {
  const raw = (process.env.DIRECT_API_VERSION ?? '').trim();
  return raw === 'v5' ? 'v5' : DEFAULT_VERSION;
}

/**
 * Адрес API. Песочница включается отдельной переменной, а не правкой базового
 * адреса: перепутать боевой кабинет с песочницей — это перепутать деньги
 * с их отсутствием, и такая развилка обязана быть названной.
 */
export function apiBase(): string {
  const override = process.env.DIRECT_API_BASE;
  if (override) {
    try {
      return new URL(override).toString();
    } catch {
      /* негодный адрес — падаем на штатный ниже */
    }
  }
  return `${useSandbox() ? SANDBOX_HOST : API_HOST}/json/${apiVersion()}/`;
}

/**
 * Имя набора глубоких полей под выбранную версию. Ровно то место, где
 * молчаливая потеря полей превращается в правильный запрос.
 */
export function fieldGroupFor(kind: 'campaign' | 'adgroup' | 'ad'): string {
  const unified = apiVersion() === 'v501';
  if (kind === 'campaign') return unified ? 'UnifiedCampaignFieldNames' : 'TextCampaignFieldNames';
  if (kind === 'adgroup') return unified ? 'UnifiedAdGroupFieldNames' : 'TextAdGroupFieldNames';
  return unified ? 'UnifiedAdFieldNames' : 'TextAdFieldNames';
}

export function useSandbox(): boolean {
  return /^(1|true|yes)$/i.test(process.env.DIRECT_SANDBOX ?? '');
}

/**
 * Расход баллов. Заголовок `Units` приходит строкой «потрачено/осталось/суточный
 * лимит», например 10/99990/100000. Суточный лимит зависит от аккаунта и у разных
 * аккаунтов отличается на порядки, поэтому зашивать его нельзя, его можно только
 * прочитать.
 */
export interface Units {
  spent: number;
  left: number;
  limit: number;
}

export function parseUnits(raw: string | null): Units | null {
  if (!raw) return null;
  const parts = raw.split('/').map((p) => Number(p.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return { spent: parts[0], left: parts[1], limit: parts[2] };
}

/** Отказ, как его описывает сам Директ. */
export interface DirectErrorBody {
  request_id?: string | number;
  error_code?: number;
  error_string?: string;
  error_detail?: string;
}

export class DirectApiError extends Error {
  constructor(
    readonly code: number,
    readonly detail: string,
    readonly requestId: string | null,
    readonly httpStatus: number,
    readonly units: Units | null,
  ) {
    super(`Директ отказал: ${code} — ${detail}`);
    this.name = 'DirectApiError';
  }
}

export interface DirectResponse {
  /** Разобранное тело: длинные целые сохранены строками. */
  result: unknown;
  httpStatus: number;
  units: Units | null;
  requestId: string | null;
  retries: number;
  /** Сырой текст — нужен отчётам, которые приезжают не JSON-ом. */
  raw: string;
  headers: Headers;
}

/** Повторяем сеть и перегрузку. Отказ по существу повтор не изменит. */
const RETRYABLE_HTTP = new Set([500, 502, 503, 504]);

/**
 * Коды Директа, при которых повтор осмыслен. 152 (суточный лимит баллов) сюда
 * НЕ входит намеренно: проверено — баллы возвращаются порциями за
 * минуты, и молчаливый повтор внутри вызова только съест их остаток. Про
 * исчерпание надо сказать вслух, а решение принимает вызывающий.
 */
const RETRYABLE_CODE = new Set([
  506, // превышено количество запросов в секунду
  1000, // сервис временно недоступен
  1001,
]);

const MAX_BACKOFF_MS = 30_000;

export interface CallOptions {
  service: string;
  /** Тело метода. У reports поля `method` нет вовсе — тогда undefined. */
  method?: string;
  params: unknown;
  token: string;
  /** Логин клиента. Обязателен агентствам; прямому рекламодателю не нужен. */
  clientLogin?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Токен уезжает в заголовок Authorization, а значение заголовка обязано быть
 * ByteString: символ вне ASCII роняет сам fetch, до сети дело не доходит, и
 * сообщение при этом не упоминает ни токен, ни заголовок. На русской раскладке
 * «с», «е», «о», «р», «а», «х» неотличимы на вид от латинских и попадают в
 * токен при наборе руками.
 */
export function tokenProblem(token: string): string | null {
  for (let i = 0; i < token.length; i++) {
    const code = token.codePointAt(i) as number;
    if (code > 0x7f) {
      const hex = code.toString(16).toUpperCase().padStart(4, '0');
      return (
        `в токене символ «${String.fromCodePoint(code)}» (U+${hex}) на позиции ${i + 1} — ` +
        'он не ASCII, и заголовок Authorization с ним не собирается вовсе. Чаще всего это ' +
        'кириллическая буква, неотличимая на вид от латинской (с, е, о, р, а, х), или ' +
        'длинное тире вместо дефиса. Наберите токен заново.'
      );
    }
  }
  return null;
}

export async function callDirect({
  service,
  method,
  params,
  token,
  clientLogin,
  headers = {},
  timeoutMs = 120_000,
  retries = 2,
}: CallOptions): Promise<DirectResponse> {
  const url = new URL(service, apiBase()).toString();
  const payload = method === undefined ? { params } : { method, params };
  const body = JSON.stringify(payload);

  let attempt = 0;

  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Accept-Language': 'ru',
          'Content-Type': 'application/json; charset=utf-8',
          ...(clientLogin ? { 'Client-Login': clientLogin } : {}),
          ...headers,
        },
        body,
        signal: controller.signal,
      });

      const text = await res.text();
      const units = parseUnits(res.headers.get('Units'));
      const requestId = res.headers.get('RequestId');

      // Отказ инфраструктуры — единственный случай, когда статус что-то значит
      // сам по себе: тела Директа тут ещё нет.
      if (RETRYABLE_HTTP.has(res.status) && attempt < retries) {
        attempt++;
        await sleep(Math.min(1000 * attempt, MAX_BACKOFF_MS));
        continue;
      }

      let parsed: unknown = null;
      if (text) {
        try {
          parsed = parseExact(text);
        } catch {
          // Отчёты приезжают TSV — это не поломка, а другой формат.
          parsed = null;
        }
      }

      const err = errorOf(parsed) ?? errorOfXml(text);
      if (err) {
        // Код приводим к числу принудительно. У обычных служб он приезжает
        // числом, а у reports — СТРОКОЙ ("8000"), и сравнение со списком
        // числовых кодов на строке молча даёт ложь: повторяемая ошибка
        // перестаёт повторяться, а неповторяемая — наоборот.
        const code = Number(err.error_code ?? 0);
        if (RETRYABLE_CODE.has(code) && attempt < retries) {
          attempt++;
          await sleep(Math.min(1000 * attempt, MAX_BACKOFF_MS));
          continue;
        }
        throw new DirectApiError(
          code,
          err.error_detail || err.error_string || 'без описания',
          err.request_id === undefined ? null : String(err.request_id),
          res.status,
          units,
        );
      }

      return {
        result: parsed,
        httpStatus: res.status,
        units,
        requestId,
        retries: attempt,
        raw: text,
        headers: res.headers,
      };
    } catch (e) {
      if (e instanceof DirectApiError) throw e;
      if (attempt < retries) {
        attempt++;
        await sleep(Math.min(1000 * attempt, MAX_BACKOFF_MS));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Достаёт объект ошибки из тела — независимо от того, какой был статус. */
export function errorOf(parsed: unknown): DirectErrorBody | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const err = (parsed as Record<string, unknown>).error;
  if (!err || typeof err !== 'object') return null;
  return err as DirectErrorBody;
}

/**
 * Вторая форма отказа. Служба отчётов отвечает XML-ошибкой, если запрос ушёл
 * на SOAP-адрес вместо JSON-адреса. Без разбора этой формы ошибка настройки
 * пути выглядит как «сервер вернул мусор» или «сервис недоступен» — то есть
 * как проблема на другом конце, а не как опечатка в адресе на своей стороне.
 */
export function errorOfXml(text: string): DirectErrorBody | null {
  if (!text.includes('<') || !/errorCode/i.test(text)) return null;
  const pick = (tag: string): string | undefined =>
    text.match(new RegExp(`<[^>]*${tag}>([^<]*)<`, 'i'))?.[1];
  const code = pick('errorCode');
  if (code === undefined) return null;
  return {
    error_code: Number(code),
    error_string: pick('errorString') ?? 'ошибка в формате XML',
    error_detail:
      (pick('errorDetail') ?? '') +
      ' (ответ пришёл XML-ом: запрос ушёл на SOAP-адрес вместо JSON-адреса)',
    request_id: pick('requestId'),
  };
}
