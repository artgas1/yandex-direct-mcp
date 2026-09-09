#!/usr/bin/env node
/**
 * Собирает spec/direct-api.json из скачанного в .cache/.
 *
 * Правило, ради которого этот файл существует: НИ ОДИН метод и ни одно поле в
 * сервере не описаны руками. Появится в Директе новая служба — она приедет сюда
 * прогоном, а тест на дрейф покраснеет до того, как расхождение кого-нибудь
 * укусит. Список из головы устаревает молча, и незаметность здесь важнее
 * скорости: сервер с потерянным методом выглядит ровно как сервер без него.
 *
 * Роли источников (замерены, см. шапку fetch-spec.mjs):
 *   WSDL + общие XSD — состав служб, операций, типов и допустимых значений.
 *   Страницы документации — человекочитаемые описания, которых в WSDL нет вовсе.
 *   reports — описана здесь явно: WSDL у неё нет, тело другое, протокол асинхронный.
 */
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

const CACHE = fileURLToPath(new URL('../.cache/', import.meta.url));
const OUT = fileURLToPath(new URL('../spec/direct-api.json', import.meta.url));

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  isArray: (name) => ['xsd:element', 'xsd:enumeration', 'xsd:attribute'].includes(name),
  removeNSPrefix: false,
});

/** Всегда массив, чем бы оно ни было. Разборщик схлопывает одиночек. */
const many = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** `ns:ClientGetItem` → `ClientGetItem`. Разрешение идёт по локальному имени. */
const local = (qname) => String(qname ?? '').split(':').pop();

/** Операция `setAuto` → элемент `SetAutoRequest`. */
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Меняющие данные операции. Разделение не косметическое: у Директа нет
 * подтверждающего шага, `archive` и `suspend` срабатывают мгновенно, и цена
 * ошибки измеряется деньгами. `delete` вынесен отдельно от прочей записи,
 * потому что он единственный необратим.
 */
const DESTRUCTIVE = new Set(['delete']);
const WRITING = new Set([
  'add',
  'update',
  'delete',
  'archive',
  'unarchive',
  'suspend',
  'resume',
  'moderate',
  'set',
  'setAuto',
  'setBids',
  'addPassportOrganization',
  'addPassportOrganizationMember',
  'deduplicate',
]);

export function kindOf(operation) {
  if (DESTRUCTIVE.has(operation)) return 'destructive';
  return WRITING.has(operation) ? 'write' : 'read';
}

/**
 * Смысл поля, который из типа не выводится.
 *
 * В WSDL и деньги, и идентификаторы объявлены одинаково — `xsd:long`, — а
 * обращаться с ними надо противоположным образом. Различить их можно только по
 * имени, поэтому список явный: догадка вида «содержит Bid — значит деньги»
 * ошибётся на CompetitorsBids и не ошибётся заметно.
 *
 * ДЕНЬГИ приходят в микро-единицах ВСЕГДА. Замер: DailyBudget.Amount
 * равен 1000000000 — это 1000 единиц валюты счёта. Заголовок returnMoneyInMicros, который
 * выключает микро-единицы в отчётах, на обычные службы НЕ действует
 * (проверено на campaigns: значение не изменилось). То есть пересчёт может
 * сделать только сам сервер.
 *
 * Список намеренно консервативен: сомнительное поле лучше оставить сырым, чем
 * поделить на миллион то, что деньгами не является. Поэтому Value, Profitability,
 * RoiCoef и Weight сюда не входят.
 */
const MONEY_FIELDS = new Set([
  'Amount',
  'AverageCpa',
  'AverageCpc',
  'AverageCpi',
  'AverageCpm',
  'AverageCpv',
  'AwaitingBonus',
  'AwaitingBonusWithoutNds',
  'Balance',
  'BalanceBonus',
  'Bid',
  'BidCeiling',
  'CompetitorsBids',
  'ContextBid',
  'Cpa',
  'CurrentSearchPrice',
  'FilterAverageCpa',
  'FilterAverageCpc',
  'MaxBid',
  'MinSearchPrice',
  'MinimumExplorationBudget',
  'NetworkBid',
  'OldPrice',
  'OverdraftSumAvailable',
  'Price',
  'Refund',
  'SearchBid',
  'Spend',
  'SpendLimit',
  'Sum',
  'SumAvailableForTransfer',
  'WeeklySpendLimit',
]);

export function semanticOf(name, type) {
  if (type !== 'long') return null;
  if (MONEY_FIELDS.has(name)) return 'money';
  if (/Ids?$/.test(name)) return 'id';
  return null;
}

/** Разбирает xsd:element в описание поля. */
function field(el) {
  const name = el['@name'];
  const minOccurs = el['@minOccurs'];
  const maxOccurs = el['@maxOccurs'];
  const inner = el['xsd:complexType'];

  const out = {
    name,
    required: minOccurs === undefined ? true : Number(minOccurs) > 0,
    array: maxOccurs === 'unbounded' || Number(maxOccurs) > 1,
  };

  if (el['@type']) {
    out.type = local(el['@type']);
  } else if (inner) {
    // Анонимный вложенный тип: разворачиваем на месте, иначе поле останется
    // без структуры и инструмент примет что угодно.
    out.type = 'inline';
    const body = bodyOf(inner);
    out.fields = body.fields;
    if (body.base) out.extends = body.base;
  } else {
    out.type = 'unknown';
  }

  const semantic = semanticOf(name, out.type);
  if (semantic) out.semantic = semantic;
  return out;
}

/**
 * Содержимое complexType: собственные поля и имя базового типа, если он есть.
 *
 * Наследование здесь не academic. Все операции `get` объявлены как
 * `complexContent > extension base="general:GetRequestGeneral"`, и разбор,
 * смотрящий только на прямую xsd:sequence, оставляет их СХЕМУ ПУСТОЙ —
 * двадцать пять методов, включая самые ходовые. Пустая схема не выглядит
 * поломкой: инструмент объявляется, вызывается и принимает что угодно.
 * В базовом типе лежит в том числе постраничность (Page), без которой
 * выборка молча обрезается.
 */
function bodyOf(complexType) {
  if (!complexType) return { fields: [], base: null };

  const ext = complexType['xsd:complexContent']?.['xsd:extension'];
  if (ext) {
    const seq = ext['xsd:sequence'] ?? ext['xsd:all'];
    return {
      fields: many(seq?.['xsd:element']).map(field),
      base: local(ext['@base']),
    };
  }

  const seq = complexType['xsd:sequence'] ?? complexType['xsd:all'];
  return { fields: many(seq?.['xsd:element']).map(field), base: null };
}

/** Совместимость с прежним вызовом: только собственные поля, без базы. */
function sequenceFields(complexType) {
  return bodyOf(complexType).fields;
}

/** Собирает таблицу типов и перечислений из одного разобранного документа. */
function collectTypes(schema, types, enums) {
  for (const st of many(schema?.['xsd:simpleType'])) {
    const name = st['@name'];
    if (!name) continue;
    const values = many(st['xsd:restriction']?.['xsd:enumeration']).map((e) => e['@value']);
    if (values.length) enums[name] = values;
  }
  for (const ct of many(schema?.['xsd:complexType'])) {
    const name = ct['@name'];
    if (!name) continue;
    const body = bodyOf(ct);
    types[name] = { name, fields: body.fields, ...(body.base ? { extends: body.base } : {}) };
  }
}

/**
 * Разворачивает цепочку наследования в плоский список полей.
 * Поля базы идут первыми; одноимённое поле наследника побеждает.
 */
function flatten(fields, base, types, seen = new Set()) {
  if (!base || seen.has(base)) return fields;
  seen.add(base);
  const parent = types[base];
  if (!parent) return fields;
  const inherited = flatten(parent.fields ?? [], parent.extends, types, seen);
  const own = new Set(fields.map((f) => f.name));
  return [...inherited.filter((f) => !own.has(f.name)), ...fields];
}

/** Достаёт заголовок и первый содержательный абзац из markdown документации. */
export function describe(md) {
  if (!md) return { title: null, summary: null };
  const lines = md.split('\n');
  let title = null;
  const paragraph = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!title) {
      const m = line.match(/^#\s+(.+)$/);
      if (m) title = m[1].trim();
      continue;
    }
    if (!line) {
      if (paragraph.length) break;
      continue;
    }
    // Директивы Diplodoc и таблицы в краткое описание не годятся.
    if (line.startsWith('{%') || line.startsWith('|') || line.startsWith('#')) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(line);
    if (paragraph.join(' ').length > 400) break;
  }
  const summary = paragraph.join(' ').replace(/\s+/g, ' ').trim() || null;
  return { title, summary: summary || null };
}

/**
 * Описание для методов, которых нет в документации.
 *
 * Таких 31 из 108, и это не небрежность разбора: служб vcards, smartadtargets,
 * dynamictextadtargets и dynamicfeedadtargets нет ни в русском индексе
 * документации, ни в английском — проверено оба. WSDL остаётся единственным
 * источником, и он структуру даёт, а слова нет.
 *
 * Пустое описание для инструмента хуже неточного: по нему модель не может
 * решить, звать его или соседний. Поэтому описание собирается из смысла самой
 * операции — он у Директа единообразен, — и помечается как собранное, а не
 * процитированное.
 */
const OPERATION_SENSE = {
  get: 'Возвращает объекты, отвечающие заданным критериям',
  add: 'Создаёт объекты',
  update: 'Изменяет параметры существующих объектов',
  delete: 'Удаляет объекты. Необратимо',
  suspend: 'Останавливает показы',
  resume: 'Возобновляет показы',
  archive: 'Помещает в архив',
  unarchive: 'Возвращает из архива',
  moderate: 'Отправляет на модерацию',
  set: 'Назначает ставки',
  setAuto: 'Включает автоматическое управление ставками',
  setBids: 'Назначает ставки или приоритеты',
  check: 'Сообщает, какие объекты изменились с указанного момента',
  checkCampaigns: 'Сообщает, какие кампании изменились с указанного момента',
  checkDictionaries: 'Сообщает, обновлялись ли справочники',
  deduplicate: 'Отсеивает дубли фраз',
  hasSearchVolume: 'Сообщает, есть ли у фраз поисковый объём',
  getGeoRegions: 'Возвращает справочник регионов',
};

const SERVICE_SENSE = {
  vcards: 'визитки',
  smartadtargets: 'условия нацеливания смарт-баннеров',
  dynamictextadtargets: 'условия нацеливания динамических объявлений',
  dynamicfeedadtargets: 'условия нацеливания динамических объявлений по фиду',
  adextensions: 'расширения объявлений',
  audiencetargets: 'условия нацеливания на аудиторию',
  bidmodifiers: 'корректировки ставок',
  negativekeywordsharedsets: 'наборы минус-фраз',
};

export function synthesize(service, operation) {
  const what = SERVICE_SENSE[service] ?? service;
  const sense = OPERATION_SENSE[operation] ?? `Операция ${operation}`;
  return `${sense} — ${what}. Описание собрано из схемы: страницы документации для этой службы Яндекс не публикует.`;
}

/**
 * Служба отчётов описывается здесь, а не выводится: WSDL у неё нет.
 * Всё, что тут указано, снято прогоном живого API — см. src/reports.ts.
 */
const REPORTS_METHOD = {
  service: 'reports',
  operation: 'get',
  tool: 'direct_reports_get',
  kind: 'read',
  docUrl: 'https://yandex.ru/dev/direct/doc/ru/reports/spec',
  title: 'Статистика по кампаниям, объявлениям, фразам и запросам',
  summary:
    'Выгрузка статистики. Единственная служба с асинхронным протоколом: ответ приходит ' +
    'не сразу (201 — поставлено в очередь, 202 — считается, 200 — готово), повторять надо ' +
    'тем же ReportName. Тело запроса без ключа method. Суммы сервер принудительно ' +
    'запрашивает в единицах валюты счёта, а не в микро-единицах.',
  request: null,
  response: 'TSV',
  note: 'описана вручную: WSDL для reports Директ не отдаёт (404)',
};

async function main() {
  const manifest = JSON.parse(await readFile(join(CACHE, 'manifest.json'), 'utf8'));

  const types = {};
  const enums = {};

  // Общие схемы разбираем первыми: на них ссылаются все службы.
  for (const name of await readdir(join(CACHE, 'xsd'))) {
    const doc = parser.parse(await readFile(join(CACHE, 'xsd', name), 'utf8'));
    collectTypes(doc['xsd:schema'], types, enums);
  }

  const methods = [];
  const problems = [];

  for (const service of manifest.services) {
    const xml = await readFile(join(CACHE, 'wsdl', `${service}.wsdl`), 'utf8');
    const doc = parser.parse(xml);
    const definitions = doc['wsdl:definitions'];
    const schema = definitions?.['wsdl:types']?.['xsd:schema'];
    collectTypes(schema, types, enums);

    const elements = new Map();
    for (const el of many(schema?.['xsd:element'])) elements.set(el['@name'], el);

    const portType = many(definitions?.['wsdl:portType']);
    const operations = new Set();
    for (const pt of portType) for (const op of many(pt['wsdl:operation'])) operations.add(op['@name']);

    for (const operation of [...operations].sort()) {
      const reqEl = elements.get(`${capitalize(operation)}Request`);
      const resEl = elements.get(`${capitalize(operation)}Response`);
      if (!reqEl) {
        problems.push(`${service}.${operation}: не найден элемент ${capitalize(operation)}Request`);
        continue;
      }

      let md = null;
      try {
        md = await readFile(join(CACHE, 'docs', service, `${operation}.md`), 'utf8');
      } catch {
        /* страницы может не быть: индекс документации неполон, это известно */
      }
      const { title, summary } = describe(md);
      const reqBody = bodyOf(reqEl['xsd:complexType']);
      const resBody = resEl ? bodyOf(resEl['xsd:complexType']) : null;

      methods.push({
        service,
        operation,
        tool: `direct_${service}_${operation.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()}`,
        kind: kindOf(operation),
        docUrl: `https://yandex.ru/dev/direct/doc/ru/${service}/${operation}`,
        title,
        summary: summary ?? synthesize(service, operation),
        summarySource: summary ? 'docs' : 'synthesized',
        // Наследование разворачивается ЗДЕСЬ, а не при чтении спеки: иначе
        // каждому потребителю пришлось бы уметь xsd, и каждый ошибался бы
        // по-своему.
        request: flatten(reqBody.fields, reqBody.base, types),
        response: resBody ? flatten(resBody.fields, resBody.base, types) : null,
        documented: md !== null,
      });
    }
  }

  // Наследование в самой таблице типов тоже разворачиваем: потребитель спеки
  // не обязан знать про xsd:extension.
  for (const t of Object.values(types)) {
    if (t.extends) {
      t.fields = flatten(t.fields, t.extends, types);
      t.inheritedFrom = t.extends;
      delete t.extends;
    }
  }

  /**
   * Сторож ровно того дефекта, на котором разбор уже один раз молча споткнулся:
   * `get` объявлен через xsd:extension, и версия без разворачивания наследования
   * оставляла двадцать пять схем пустыми, не подав ни одного признака.
   * Пустая схема запроса у читающей операции — всегда ошибка разбора,
   * а не свойство API.
   */
  for (const m of methods) {
    if (m.operation === 'get' && Array.isArray(m.request) && m.request.length === 0) {
      problems.push(`${m.service}.get: пустая схема запроса — наследование не развернулось`);
    }
  }

  methods.push(REPORTS_METHOD);
  methods.sort((a, b) => a.tool.localeCompare(b.tool));

  const spec = {
    source: {
      wsdl: 'https://api.direct.yandex.com/v5/<service>?wsdl',
      xsd: 'https://soap.direct.yandex.ru/v5/<name>.xsd',
      docs: 'https://yandex.ru/dev/direct/doc/ru/llms.txt',
    },
    counts: {
      services: manifest.services.length + 1,
      methods: methods.length,
      types: Object.keys(types).length,
      enums: Object.keys(enums).length,
      undocumented: methods.filter((m) => m.documented === false).length,
    },
    kinds: {
      read: methods.filter((m) => m.kind === 'read').length,
      write: methods.filter((m) => m.kind === 'write').length,
      destructive: methods.filter((m) => m.kind === 'destructive').length,
    },
    /**
     * Оговорки к спеке. Не украшение: каждая меняет то, как её можно
     * использовать, и каждая снята сверкой, а не предположена.
     */
    caveats: [
      'WSDL ОТСТАЁТ ОТ ЖИВОГО API по составу перечислений. Сверка ' +
        'подстановкой неверного FieldNames: campaigns принимает CreateTime, keywords — ' +
        'AutotargetingBrief, AutotargetingBriefSuggests и AutotargetingMode, а в схеме ' +
        'их нет. Поэтому перечисления идут в ОПИСАНИЯ как подсказка и не превращаются ' +
        'в жёсткий фильтр: фильтр по устаревшему списку запретил бы то, что API умеет, ' +
        'и отказ выглядел бы как отсутствие возможности. Право решать остаётся за API.',
      'Служба reports описана вручную: WSDL для неё Директ не отдаёт (404).',
      'У 31 метода описание собрано из схемы, а не процитировано: служб vcards, ' +
        'smartadtargets, dynamictextadtargets и dynamicfeedadtargets нет ни в русском ' +
        'индексе документации, ни в английском.',
    ],
    methods,
    types,
    enums,
    problems,
  };

  await mkdir(fileURLToPath(new URL('../spec/', import.meta.url)), { recursive: true });
  await writeFile(OUT, JSON.stringify(spec, null, 2));

  console.error(
    `спека собрана: служб ${spec.counts.services}, методов ${spec.counts.methods}, ` +
      `типов ${spec.counts.types}, перечислений ${spec.counts.enums}`,
  );
  console.error(
    `по характеру: читающих ${spec.kinds.read}, меняющих ${spec.kinds.write}, ` +
      `удаляющих ${spec.kinds.destructive}`,
  );
  console.error(`без страницы документации: ${spec.counts.undocumented}`);
  if (problems.length) {
    console.error(`ПРОБЛЕМЫ РАЗБОРА: ${problems.length}`);
    for (const p of problems.slice(0, 10)) console.error('  •', p);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
