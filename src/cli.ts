import { annotate, KIND_LABEL } from './annotations.js';
import { apiVersion, callDirect, DirectApiError, tokenProblem, useSandbox } from './http.js';
import { moneyFields, normalizeMoney } from './money.js';
import { countRows, parseTsv, runReport } from './reports.js';
import { loadSpec, type Method, type Spec } from './spec.js';
import { summarizeResults, unwrapItems, versionNotes, wireValue } from './tools.js';

/**
 * Режим командной строки.
 *
 * Существует ради тех, кому MCP не нужен или недоступен: агент со скиллом,
 * скрипт, разбор в терминале. Важное свойство — этот режим НЕ делает
 * собственных запросов и не знает про Директ ничего своего: он зовёт тот же
 * транспорт и ту же спеку, что и сервер. Иначе получилось бы два разных
 * представления одного API, которые расходятся молча, и чинить пришлось бы оба.
 */

export const CLI_COMMANDS: ReadonlySet<string> = new Set([
  'call',
  'describe',
  'catalog',
  'fields',
  'help',
  '--help',
  '-h',
]);

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | string[] | boolean>;
}

/** Разбор аргументов: --ключ значение, --ключ=значение, --no-ключ, повторы копятся. */
export function parseArgv(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | string[] | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    if (token.startsWith('--no-')) {
      flags[token.slice(5)] = false;
      continue;
    }
    const eq = token.indexOf('=');
    let key: string;
    let value: string | boolean;
    if (eq > 0) {
      key = token.slice(2, eq);
      value = token.slice(eq + 1);
    } else {
      key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i++;
      } else {
        value = true;
      }
    }
    const existing = flags[key];
    if (existing === undefined) flags[key] = value;
    else if (Array.isArray(existing)) existing.push(String(value));
    else flags[key] = [String(existing), String(value)];
  }

  return { positional, flags };
}

/** `campaigns.get`, `campaigns get`, `direct_campaigns_get` — всё одно и то же. */
export function resolveMethod(spec: Spec, raw: string): Method | null {
  const normalized = raw.trim().toLowerCase().replace(/[.\s-]+/g, '_');
  const withPrefix = normalized.startsWith('direct_') ? normalized : `direct_${normalized}`;
  return spec.methods.find((m) => m.tool === withPrefix) ?? null;
}

const emit = (io: CliIo, value: unknown): void => io.out(JSON.stringify(value, null, 2));

function usage(io: CliIo, spec: Spec): void {
  io.out(
    [
      'yandex-direct-mcp — работа с API Яндекс Директа из командной строки.',
      '',
      'Токен: переменная окружения YANDEX_DIRECT_TOKEN (OAuth Яндекса, scope direct:api).',
      '',
      'Команды:',
      '  catalog [--service <имя>]        какие методы есть (всего ' + spec.methods.length + ')',
      '  describe <служба.метод>          какие параметры принимает метод',
      '  fields [<имя перечисления>]      допустимые значения',
      '  call <служба.метод> [параметры]  вызвать',
      '',
      'Параметры вызова:',
      '  --Имя значение строка или число',
      '  --Имя a --Имя b повтор даёт массив',
      '  --Имя@json \'{"…"}\'    произвольный JSON для вложенного объекта',
      '',
      'Примеры:',
      '  yandex-direct-mcp catalog --service campaigns',
      '  yandex-direct-mcp describe campaigns.get',
      '  yandex-direct-mcp call campaigns.get --FieldNames Id --FieldNames Name',
      '  yandex-direct-mcp call reports.get --ReportType CAMPAIGN_PERFORMANCE_REPORT \\',
      '      --FieldNames CampaignId --FieldNames Cost --DateRangeType LAST_30_DAYS',
      '',
      'Коды возврата: 0 успех, 1 отказ API, 2 ошибка вызова, 3 изменение запрещено, 4 нет токена.',
      '',
      'Изменяющие методы требуют DIRECT_ALLOW_WRITES=1 — у Директа нет подтверждающего шага,',
      'suspend и archive срабатывают в момент вызова, delete необратим.',
    ].join('\n'),
  );
}

function describe(io: CliIo, spec: Spec, method: Method): void {
  const lines = [
    `${method.service}.${method.operation} — ${KIND_LABEL[method.kind]}`,
    method.summary ?? '',
    `документация: ${method.docUrl}`,
    '',
    'Параметры:',
  ];
  for (const f of method.request ?? []) {
    const values = spec.enums[f.type];
    const detail =
      (values ? ` значения: ${values.slice(0, 12).join(', ')}${values.length > 12 ? ', …' : ''}` : '') +
      (f.semantic === 'money' ? ' (сумма в валюте счёта, не в микро-единицах)' : '') +
      (f.semantic === 'id' ? ' (идентификатор; длинные передавайте строкой)' : '');
    lines.push(
      `  --${f.name}${f.array ? ' (можно повторять)' : ''}: ${f.type}` +
        `${f.required ? ', обязательно' : ''}${detail}`,
    );
  }
  io.out(lines.join('\n'));
}

export async function runCli(argv: readonly string[], io: CliIo = defaultIo): Promise<number> {
  const spec = loadSpec();
  const { positional, flags } = parseArgv(argv);
  const command = positional[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    usage(io, spec);
    return 0;
  }

  if (command === 'catalog') {
    const service = typeof flags.service === 'string' ? flags.service : null;
    const rows = spec.methods.filter((m) => !service || m.service === service);
    if (!rows.length) {
      io.err(`службы ${service} нет. Всего служб: ${new Set(spec.methods.map((m) => m.service)).size}.`);
      return 2;
    }
    const grouped: Record<string, string[]> = {};
    for (const m of rows) (grouped[m.service] ??= []).push(`${m.operation} (${KIND_LABEL[m.kind]})`);
    emit(io, { всего: rows.length, методы: grouped });
    return 0;
  }

  if (command === 'fields') {
    const name = positional[1];
    if (!name) {
      emit(io, { перечислений: Object.keys(spec.enums).length, имена: Object.keys(spec.enums).sort() });
      return 0;
    }
    const values = spec.enums[name];
    if (!values) {
      io.err(`перечисления ${name} нет. Посмотрите список: fields без аргумента.`);
      return 2;
    }
    emit(io, { перечисление: name, значения: values });
    return 0;
  }

  if (command === 'describe') {
    const method = positional[1] ? resolveMethod(spec, positional[1]) : null;
    if (!method) {
      io.err(`не нашёл метод «${positional[1] ?? ''}». Список: catalog.`);
      return 2;
    }
    describe(io, spec, method);
    return 0;
  }

  if (command !== 'call') {
    io.err(`неизвестная команда «${command}». Справка: help.`);
    return 2;
  }

  const method = positional[1] ? resolveMethod(spec, positional[1]) : null;
  if (!method) {
    io.err(`не нашёл метод «${positional[1] ?? ''}». Список: catalog.`);
    return 2;
  }

  const allowWrites = /^(1|true|yes)$/i.test(process.env.DIRECT_ALLOW_WRITES ?? '');
  if (method.kind !== 'read' && !allowWrites) {
    io.err(
      `${method.service}.${method.operation} изменяет данные (${KIND_LABEL[method.kind]}), а изменение выключено. ` +
        'Включается переменной DIRECT_ALLOW_WRITES=1. У Директа нет подтверждающего шага: ' +
        'suspend и archive срабатывают в момент вызова, delete необратим.',
    );
    return 3;
  }

  const token = process.env.YANDEX_DIRECT_TOKEN ?? process.env.YANDEX_API_KEY;
  if (!token) {
    io.err('нет токена: задайте YANDEX_DIRECT_TOKEN (OAuth Яндекса, scope direct:api).');
    return 4;
  }
  const badToken = tokenProblem(token);
  if (badToken) {
    io.err(`токен непригоден: ${badToken}`);
    return 4;
  }

  // Собираем параметры из флагов. Ключ вида --Имя@json принимает готовый JSON —
  // без него вложенные объекты в командной строке не выразить.
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flags)) {
    if (key === 'service') continue;
    if (key.endsWith('@json')) {
      const name = key.slice(0, -5);
      try {
        params[name] = JSON.parse(String(value));
      } catch (e) {
        io.err(`--${key}: не разобрал JSON — ${e instanceof Error ? e.message : String(e)}`);
        return 2;
      }
      continue;
    }
    const field = (method.request ?? []).find((f) => f.name === key);
    let normalized: unknown = value;
    if (Array.isArray(value)) normalized = value;
    else if (typeof value === 'string' && field && field.array) normalized = [value];
    if (field?.semantic === 'money' && typeof normalized === 'string') normalized = Number(normalized);
    params[key] = normalized;
  }

  const money = moneyFields(spec);
  const clientLogin = process.env.YANDEX_DIRECT_LOGIN || undefined;

  try {
    if (method.tool === 'direct_reports_get') {
      const { tsv, polls, units } = await runReport({
        params: {
          // Обязательные поля, про которые API молчит до самого вызова.
          // IncludeVAT в докладной части не помечен обязательным, а запрос без
          // него отбивается кодом 8000 «В params отсутствует обязательное поле
          // IncludeVAT». MCP-инструмент подставлял его, а этот режим — нет, и
          // расхождение нашлось только настоящей задачей: справка и describe
          // о нём не сообщали.
          IncludeVAT: 'YES',
          DateRangeType: 'CUSTOM_DATE',
          ...params,
          Format: 'TSV',
          ReportName: `cli_${Date.now().toString(36)}`,
        },
        token,
        clientLogin,
      });
      const total = countRows(tsv);
      const { columns, rows } = parseTsv(tsv, 5000);
      emit(io, {
        _мета: { версия_api: apiVersion(), песочница: useSandbox() || undefined, запросов: polls, баллы: units },
        строк: total,
        columns,
        rows,
      });
      return 0;
    }

    const res = await callDirect({
      service: method.service,
      method: method.operation,
      params: wireValue(params, method, spec, money),
      token,
      clientLogin,
    });
    const raw = (res.result as Record<string, unknown> | null)?.result ?? res.result;
    const { value, converted } = normalizeMoney(unwrapItems(raw), money);
    const notes = [summarizeResults(value), ...versionNotes(params)].filter(Boolean);

    emit(io, {
      _мета: {
        версия_api: apiVersion(),
        песочница: useSandbox() || undefined,
        баллы: res.units,
        суммы_переведены_из_микроединиц: converted.length ? converted : undefined,
        внимание: notes.length ? notes : undefined,
      },
      данные: value,
    });
    return 0;
  } catch (e) {
    if (e instanceof DirectApiError) {
      // Отказ печатается в stdout тем же JSON-ом, что и успех: потребитель
      // этого режима — агент, и ему разумнее читать один поток, а не два.
      emit(io, {
        ошибка: { код: e.code, описание: e.detail, request_id: e.requestId, http: e.httpStatus },
        баллы: e.units,
      });
      return 1;
    }
    io.err(`запрос не выполнен: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

/** Аннотации доступны и в этом режиме — они часть описания метода. */
export { annotate };
