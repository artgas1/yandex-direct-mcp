import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { annotate, KIND_LABEL } from './annotations.js';
import { callDirect, DirectApiError, apiVersion, useSandbox, type Units } from './http.js';
import { resolveCabinet, type Cabinet } from './identity.js';
import { moneyFields, normalizeMoney, toMicro } from './money.js';
import { countRows, parseTsv, runReport } from './reports.js';
import { registerInventory } from './inventory.js';
import { isWrapperArray, type Field, type Method, type Spec } from './spec.js';

/** Потолок ответа. Отчёт легко даёт десятки тысяч строк — это не помещается никуда. */
export const DEFAULT_MAX_OUTPUT_CHARS = 60_000;

/** Enum короче этого показываем целиком; длинные — отправляем в direct_fields. */
const INLINE_ENUM_LIMIT = 8;

/** Ровно та часть McpServer, которой пользуемся. Своя форма разошлась бы с SDK. */
type Registrar = Pick<McpServer, 'registerTool'>;

interface ToolResult {
  // Индексная сигнатура нужна SDK: его тип результата допускает произвольные
  // дополнительные ключи, и без неё более узкий тип этого сервера ему не подходит.
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const text = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

const failure = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

/**
 * Схема одного поля.
 *
 * Главное решение здесь — НЕ РАЗВОРАЧИВАТЬ вложенные типы. Причина
 * арифметическая: транзитивное разворачивание `campaigns.add` даёт 1083 поля и
 * 548 значений перечислений в одном инструменте, то есть 54 КБ на единственный
 * инструмент — вдвое больше, чем весь профиль `core` целиком. Описания всех
 * объявленных инструментов лежат в контексте модели на каждом ходу, поэтому
 * такая схема — это налог на каждый ход ради случая, который наступает раз
 * в месяц.
 *
 * Вместо разворачивания поле объявляется свободным объектом, а его СОСТАВ
 * называется словами в описании. Модель узнаёт, что положить внутрь, из одной
 * строки, а точную схему берёт инструментом direct_schema, когда она
 * действительно нужна.
 */
function fieldSchema(field: Field, spec: Spec): z.ZodTypeAny {
  const described = (schema: z.ZodTypeAny, note: string): z.ZodTypeAny => schema.describe(note);

  // Обёрточный тип: на проводе это {"Items": [...]}, но от модели принимаем
  // обычный массив и оборачиваем сами (см. wireValue). Так модель работает с
  // одной формой списка, а не с двумя.
  if (isWrapperArray(field)) {
    const inner = field.type.replace(/^ArrayOf/, '');
    return described(
      z.array(inner === 'Long' ? z.union([z.string(), z.number()]) : z.string()).optional(),
      `список (${inner}); передавайте обычным массивом — обёртку Items сервер поставит сам`,
    );
  }

  const enumValues = spec.enums[field.type];
  let base: z.ZodTypeAny;
  let note = '';

  if (enumValues) {
    // Перечисление НЕ становится жёстким фильтром. Сверка с живым API
    // показала, что схема отстаёт: campaigns принимает CreateTime,
    // keywords — три значения автотаргетинга, которых в WSDL нет. Фильтр по
    // отстающему списку запретил бы то, что API умеет, и отказ выглядел бы
    // как отсутствие возможности.
    base = z.string();
    note =
      enumValues.length <= INLINE_ENUM_LIMIT
        ? `одно из: ${enumValues.join(', ')}`
        : `${enumValues.length} значений (${enumValues.slice(0, 4).join(', ')}, …) — полный список: direct_fields`;
  } else if (field.semantic === 'money') {
    base = z.number();
    note = 'сумма в валюте счёта (например 30.5 — это 30 рублей 50 копеек); в микро-единицы переводит сервер';
  } else if (field.semantic === 'id' || field.type === 'long') {
    // Идентификаторы принимаем и строкой, и числом: длинные не помещаются в
    // число JavaScript, а API принимает обе формы (проверено).
    base = z.union([z.string(), z.number()]);
    note = field.semantic === 'id' ? 'идентификатор; длинные передавайте строкой' : 'целое число';
  } else if (field.type === 'int' || field.type === 'integer') {
    base = z.number();
  } else if (field.type === 'boolean') {
    base = z.boolean();
  } else if (field.type === 'string' || field.type === 'unknown') {
    base = z.string();
  } else {
    const type = spec.types[field.type];
    const names = (type?.fields ?? field.fields ?? []).map((f) => f.name);
    base = z.record(z.unknown());
    note = names.length
      ? `объект ${field.type}: ${names.slice(0, 14).join(', ')}${names.length > 14 ? ', …' : ''}` +
        ` (точная схема: direct_schema с type=${field.type})`
      : `объект ${field.type} (схема: direct_schema с type=${field.type})`;
  }

  const shaped = field.array ? z.array(base) : base;
  const withNote = note ? shaped.describe(note) : shaped;
  return field.required ? withNote : withNote.optional();
}

function requestSchema(method: Method, spec: Spec): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of method.request ?? []) shape[f.name] = fieldSchema(f, spec);
  return shape;
}

/**
 * Приведение того, что дала модель, к форме провода: денежные значения
 * умножаются на миллион, списки обёрточных типов заворачиваются в Items.
 * Обе операции — зеркало того, что делается на чтении, и держатся они на графе
 * типов, а не на виде значения.
 */
export function wireValue(params: Record<string, unknown>, method: Method, spec: Spec, money: Set<string>): unknown {
  const out: Record<string, unknown> = {};
  const byName = new Map((method.request ?? []).map((f) => [f.name, f]));

  for (const [key, raw] of Object.entries(params)) {
    if (raw === undefined) continue;
    const field = byName.get(key);
    if (field && isWrapperArray(field) && Array.isArray(raw)) {
      out[key] = { Items: raw };
      continue;
    }
    out[key] = toMicro(raw, money);
  }
  return out;
}

/**
 * Разворачивает {"Items": [...]} обратно в обычный массив.
 *
 * Делать это безопасно ровно потому, что вход зеркален: модель отдаёт списки
 * обычными массивами, а обёртку сервер ставит сам по графу типов. Пара
 * «развернул на чтении — завернул на записи» замкнута, и круг
 * «прочитал → поправил → записал» не рвётся. Разворачивать в одну сторону,
 * не умея завернуть обратно, было бы хуже, чем не разворачивать вовсе.
 */
export function unwrapItems(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(unwrapItems);
  if (!node || typeof node !== 'object') return node;
  const obj = node as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1 && keys[0] === 'Items') return unwrapItems(obj.Items);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = unwrapItems(v);
  return out;
}

/**
 * Итог поэлементной операции.
 *
 * Отдельная функция потому, что здесь легко посчитать наоборот. В ответе на
 * add/update каждому входному элементу отвечает выходной, и различать надо по
 * `Errors`, а не по «есть ли что-то в элементе»: `Warnings` — это ПРИМЕНЕНО
 * с замечанием. Типовая ошибка счёта — считать отказом всё, у чего в элементе
 * что-то есть: тогда пачка, применённая с предупреждениями, выглядит как
 * «ошибок N, применено 0», хотя применились все N. Отказ обозначает только `Errors`.
 */
export function summarizeResults(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const bag = result as Record<string, unknown>;
  const key = Object.keys(bag).find((k) => /Results$/.test(k));
  if (!key || !Array.isArray(bag[key])) return null;

  const items = bag[key] as Array<Record<string, unknown>>;
  let applied = 0;
  let rejected = 0;
  let warned = 0;
  for (const item of items) {
    const errors = Array.isArray(item.Errors) ? item.Errors.length : 0;
    if (errors > 0) rejected++;
    else applied++;
    if (Array.isArray(item.Warnings) && item.Warnings.length) warned++;
  }
  return (
    `${key}: применено ${applied}, отклонено ${rejected}` +
    (warned ? `, с предупреждениями ${warned} (предупреждение — это ПРИМЕНЕНО, а не отказ)` : '')
  );
}

export interface RegisterOptions {
  allowWrites: boolean;
  maxOutputChars: number;
  include: (method: Method) => boolean;
  clientLogin?: string;
}

function envelope(
  payload: unknown,
  extras: { units: Units | null; converted: string[]; notes: string[]; cabinet?: Cabinet | null },
  maxChars: number,
): ToolResult {
  const body = JSON.stringify(payload);
  const truncated = body.length > maxChars;
  const meta: Record<string, unknown> = {
    // Кабинет называется в каждом ответе, потому что перепутать его можно молча:
    // неверный Client-Login отбивается кодом 8800, а верный, но не тот — просто
    // отдаёт данные другого кабинета, и по виду ответа это неотличимо.
    кабинет: extras.cabinet
      ? `${extras.cabinet.login} (ClientId ${extras.cabinet.clientId})`
      : 'не определён',
    версия_api: apiVersion(),
    ...(useSandbox() ? { песочница: true } : {}),
  };
  if (extras.units) {
    meta.баллы = `потрачено ${extras.units.spent}, осталось ${extras.units.left} из ${extras.units.limit}`;
  }
  if (extras.converted.length) {
    meta.суммы_переведены_из_микроединиц = extras.converted;
  }
  if (extras.notes.length) meta.внимание = extras.notes;
  if (truncated) {
    meta.усечено = `ответ ${body.length} символов, показано ${maxChars}. Сузьте выборку или запросите меньше полей.`;
  }

  return text({
    _мета: meta,
    данные: truncated ? `${body.slice(0, maxChars)}…` : payload,
  });
}

export function registerAll(server: Registrar, spec: Spec, token: string, options: RegisterOptions): number {
  const money = moneyFields(spec);
  let count = 0;

  for (const method of spec.methods) {
    if (!options.include(method)) continue;
    if (method.tool === 'direct_reports_get') {
      registerReport(server, spec, token, options);
      count++;
      continue;
    }

    const shape = requestSchema(method, spec);
    const description =
      `${method.summary ?? method.title ?? method.tool}` +
      `\n\nСлужба ${method.service}, метод ${method.operation} (${KIND_LABEL[method.kind]}).` +
      (method.kind === 'destructive' ? ' НЕОБРАТИМО: подтверждения у API нет, отмены нет.' : '') +
      (method.kind === 'write' ? ' Применяется немедленно, подтверждающего шага у API нет.' : '') +
      `\nДокументация: ${method.docUrl}`;

    server.registerTool(
      method.tool,
      {
        title: `${method.service}.${method.operation}`,
        description,
        inputSchema: shape,
        annotations: annotate(method),
      },
      async (args: Record<string, unknown>) => {
        const params = wireValue((args ?? {}) as Record<string, unknown>, method, spec, money);
        try {
          const res = await callDirect({
            service: method.service,
            method: method.operation,
            params,
            token,
            clientLogin: options.clientLogin,
          });
          const raw = (res.result as Record<string, unknown> | null)?.result ?? res.result;
          const unwrapped = unwrapItems(raw);
          const { value, converted } = normalizeMoney(unwrapped, money);

          const notes: string[] = [];
          const summary = summarizeResults(value);
          if (summary) notes.push(summary);
          notes.push(...versionNotes(params));

          const cabinet = await resolveCabinet(token, options.clientLogin);
          return envelope(value, { units: res.units, converted, notes, cabinet }, options.maxOutputChars);
        } catch (e) {
          return failure(describeError(e));
        }
      },
    );
    count++;
  }

  registerHelpers(server, spec);

  // Состав кабинета склеивается из двух источников. Регистрируется рядом с
  // отчётом: смысл у него тот же — ответить, что в кабинете есть на самом деле.
  if (options.include(spec.methods.find((m) => m.tool === 'direct_reports_get') as Method)) {
    registerInventory(server, {
      token,
      clientLogin: options.clientLogin,
      maxOutputChars: options.maxOutputChars,
    });
  }

  // Возвращается число инструментов API — служебные сюда не входят. Раньше
  // сводка попадала в этот счёт, а остальные служебные нет, и величина не
  // означала ничего: ни «объявлено», ни «методов».
  return count;
}

/**
 * Предупреждение о несовпадении версии пути и набора глубоких полей.
 *
 * Тот самый молчаливый случай: на v501 запрос с TextCampaignFieldNames проходит
 * успешно и просто не приносит глубоких полей. Ошибки нет, поэтому сказать про
 * это может только сервер.
 */
export function versionNotes(params: unknown): string[] {
  if (!params || typeof params !== 'object') return [];
  const keys = Object.keys(params as Record<string, unknown>);
  const unified = apiVersion() === 'v501';
  const wrongPrefix = unified ? /^Text.*FieldNames$/ : /^Unified.*FieldNames$/;
  const bad = keys.filter((k) => wrongPrefix.test(k));
  if (!bad.length) return [];
  return [
    `запрошены ${bad.join(', ')}, а сервер работает по ${apiVersion()}, где кампании имеют тип ` +
      `${unified ? 'UNIFIED_CAMPAIGN' : 'TEXT_CAMPAIGN'}. Такой запрос НЕ вернёт глубокие поля и НЕ выдаст ошибку. ` +
      `Используйте ${unified ? 'Unified*FieldNames' : 'Text*FieldNames'} либо смените DIRECT_API_VERSION.`,
  ];
}

function describeError(e: unknown): string {
  if (e instanceof DirectApiError) {
    const hint =
      e.code === 152
        ? ' Суточный запас баллов исчерпан. Он восстанавливается порциями в течение дня, а не разом в полночь.'
        : e.code === 53 || e.code === 54
          ? ' Проверьте токен и права на этот кабинет (Client-Login).'
          : e.code === 4001
            ? ' Не хватает обязательного условия выборки: обычно нужны CampaignIds или AdGroupIds.'
            : '';
    return (
      `Директ отказал: код ${e.code}. ${e.detail}${hint}` +
      (e.requestId ? `\nrequest_id: ${e.requestId}` : '') +
      (e.units ? `\nбаллы: осталось ${e.units.left} из ${e.units.limit}` : '')
    );
  }
  return `Запрос не выполнен: ${e instanceof Error ? e.message : String(e)}`;
}

/** Служба отчётов регистрируется отдельно: у неё другое тело и другой протокол. */
function registerReport(server: Registrar, spec: Spec, token: string, options: RegisterOptions): void {
  const reportTypes = spec.enums.ReportTypeEnum ?? [];
  const dateRanges = spec.enums.DateRangeTypeEnum ?? [];

  server.registerTool(
    'direct_reports_get',
    {
      title: 'reports.get',
      description:
        'Статистика: показы, клики, расход, конверсии по кампаниям, группам, объявлениям и запросам. ' +
        'Это основной инструмент счёта.\n\n' +
        'ВАЖНО о составе кабинета: список кампаний из campaigns.get неполон — кампании Мастера кампаний ' +
        'в него не попадают вовсе, без ошибки и без признака. Отчёт видит всё, что откручивалось, ' +
        'поэтому состав кабинета определяется отсюда, а не из списка кампаний.\n\n' +
        'Суммы приходят в валюте счёта: сервер запрашивает их у API в рублях, а не в микро-единицах.\n' +
        'Документация по полям: https://yandex.ru/dev/direct/doc/ru/reports/fields-list',
      inputSchema: {
        ReportType: z
          .string()
          .describe(reportTypes.length ? `одно из: ${reportTypes.join(', ')}` : 'тип отчёта'),
        FieldNames: z.array(z.string()).describe('колонки отчёта; список — direct_fields с service=reports'),
        DateRangeType: z
          .string()
          .optional()
          .describe(dateRanges.length ? `одно из: ${dateRanges.slice(0, 10).join(', ')}, …` : 'период'),
        DateFrom: z.string().optional().describe('YYYY-MM-DD; нужен при DateRangeType=CUSTOM_DATE'),
        DateTo: z.string().optional().describe('YYYY-MM-DD; нужен при DateRangeType=CUSTOM_DATE'),
        Goals: z.array(z.string()).optional().describe('идентификаторы целей Метрики'),
        AttributionModels: z
          .array(z.string())
          .optional()
          .describe('модели атрибуции; допустимы ТОЛЬКО вместе с Goals, иначе API откажет'),
        Filter: z
          .array(z.record(z.unknown()))
          .optional()
          .describe('условия отбора; всегда массив, даже для одного условия'),
        Limit: z.number().optional().describe('сколько строк вернуть'),
        IncludeVAT: z.string().optional().describe('YES или NO'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: Record<string, unknown>) => {
      const input = (args ?? {}) as Record<string, unknown>;
      const params: Record<string, unknown> = {
        SelectionCriteria: {},
        ReportType: input.ReportType,
        DateRangeType: input.DateRangeType ?? 'CUSTOM_DATE',
        FieldNames: input.FieldNames,
        Format: 'TSV',
        IncludeVAT: input.IncludeVAT ?? 'YES',
        // Имя должно быть своим у каждого запроса: повтор с тем же именем —
        // это обращение к УЖЕ поставленной задаче, а не новый отчёт.
        ReportName: `mcp_${apiVersion()}_${hash(JSON.stringify(input))}`,
      };
      const criteria: Record<string, unknown> = {};
      if (input.DateFrom) criteria.DateFrom = input.DateFrom;
      if (input.DateTo) criteria.DateTo = input.DateTo;
      if (input.Filter) criteria.Filter = input.Filter;
      params.SelectionCriteria = criteria;
      if (input.Goals) params.Goals = input.Goals;
      if (input.AttributionModels) params.AttributionModels = input.AttributionModels;
      if (input.Limit) params.Page = { Limit: input.Limit };

      if (input.AttributionModels && !input.Goals) {
        return failure(
          'AttributionModels допустимы только вместе с Goals — API отклонит такой запрос. ' +
            'Укажите Goals (идентификаторы целей Метрики) или уберите AttributionModels.',
        );
      }

      try {
        const { tsv, polls, units } = await runReport({ params, token, clientLogin: options.clientLogin });
        const total = countRows(tsv);
        const limit = Math.max(1, Math.floor(options.maxOutputChars / 120));
        const { columns, rows } = parseTsv(tsv, limit);
        const notes: string[] = [];
        if (total > rows.length) {
          notes.push(`строк в отчёте ${total}, показано ${rows.length}. Сузьте период или добавьте Filter.`);
        }
        if (polls > 1) notes.push(`отчёт считался, потребовалось запросов: ${polls}`);
        const cabinet = await resolveCabinet(token, options.clientLogin);
        return envelope({ columns, rows }, { units, converted: [], notes, cabinet }, options.maxOutputChars);
      } catch (e) {
        return failure(describeError(e));
      }
    },
  );
}

/** Короткий устойчивый хеш для имени отчёта. */
function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * Вспомогательные инструменты. Они существуют ради того, чтобы схемы оставались
 * маленькими: то, что не лежит в контексте постоянно, спрашивается по факту.
 */
function registerHelpers(server: Registrar, spec: Spec): void {
  server.registerTool(
    'direct_fields',
    {
      title: 'Допустимые значения',
      description:
        'Перечисляет допустимые значения перечисления: колонки отчётов, наборы FieldNames, типы кампаний. ' +
        'Нужен потому, что полные списки в описания инструментов не помещаются. ' +
        'ВАЖНО: список порождён из схемы, а схема отстаёт от живого API — он принимает и то, чего здесь нет. ' +
        'Значение вне списка не считайте недопустимым: право решать за API.',
      inputSchema: {
        name: z.string().optional().describe('имя перечисления, например CampaignFieldEnum'),
        search: z.string().optional().describe('поиск по имени перечисления'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args: Record<string, unknown>) => {
      const { name, search } = (args ?? {}) as { name?: string; search?: string };
      if (name) {
        const values = spec.enums[name];
        return values
          ? text({ перечисление: name, значений: values.length, значения: values })
          : failure(`перечисления ${name} в спеке нет. Поищите: direct_fields с search=…`);
      }
      const needle = (search ?? '').toLowerCase();
      const names = Object.keys(spec.enums)
        .filter((n) => !needle || n.toLowerCase().includes(needle))
        .sort();
      return text({ найдено: names.length, перечисления: names.slice(0, 120) });
    },
  );

  server.registerTool(
    'direct_schema',
    {
      title: 'Схема типа',
      description:
        'Возвращает точный состав типа Директа — какие поля, какие обязательны, какие списки. ' +
        'Нужен перед созданием и изменением объектов: вложенные типы в схемы инструментов не ' +
        'разворачиваются, потому что один только CampaignAddItem это больше тысячи полей.',
      inputSchema: {
        type: z.string().describe('имя типа, например CampaignAddItem или KeywordUpdateItem'),
        depth: z.number().optional().describe('глубина разворачивания, по умолчанию 1'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args: Record<string, unknown>) => {
      const { type, depth = 1 } = (args ?? {}) as { type: string; depth?: number };
      const seen = new Set<string>();
      const expand = (name: string, left: number): unknown => {
        const t = spec.types[name];
        if (!t) return spec.enums[name] ? { перечисление: spec.enums[name] } : `неизвестный тип ${name}`;
        if (seen.has(name) || left < 0) return `${name} (уже показан выше или глубже запрошенного)`;
        seen.add(name);
        const out: Record<string, unknown> = {};
        for (const f of t.fields) {
          const label =
            `${f.type}${f.array ? '[]' : ''}` +
            `${f.required ? ', обязательно' : ''}` +
            `${f.semantic === 'money' ? ', сумма в валюте счёта' : ''}` +
            `${isWrapperArray(f) ? ', список (обёртку Items ставит сервер)' : ''}`;
          out[f.name] = left > 0 && spec.types[f.type] ? { тип: label, поля: expand(f.type, left - 1) } : label;
        }
        return out;
      };
      return text({ тип: type, поля: expand(type, Math.min(depth, 3)) });
    },
  );
}
