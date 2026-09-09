#!/usr/bin/env node
/**
 * Скачивает исходники спеки в .cache/: WSDL всех служб и страницы документации.
 *
 * Почему источника два и почему именно так поделены роли — измерено прогоном:
 *
 *   WSDL: 28 служб, 107 операций. Полный состав и точные типы, но без единого
 *         человекочитаемого описания (xs:documentation в нём нет).
 *   Индекс документации llms.txt: 24 службы. Не хватает vcards, smartadtargets,
 *         dynamictextadtargets, dynamicfeedadtargets — то есть по нему одному
 *         спека вышла бы неполной, и неполнота была бы невидимой.
 *
 * Отсюда разделение: СОСТАВ И ТИПЫ берём из WSDL, ОПИСАНИЯ — из документации.
 * Служба reports WSDL не отдаёт вовсе (404) и описывается отдельно: у неё и
 * тело запроса другое, и протокол асинхронный.
 *
 * Кеш не коммитится: источник истины — сам Яндекс, в репозитории живёт
 * разобранная спека.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LLMS_URL = 'https://yandex.ru/dev/direct/doc/ru/llms.txt';
export const WSDL_URL = (service) => `https://api.direct.yandex.com/v5/${service}?wsdl`;
export const CACHE_DIR = fileURLToPath(new URL('../.cache/', import.meta.url));

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

/**
 * Службы, которые WSDL отдаёт. Список НЕ зашит: он выводится из индекса
 * документации и дополняется теми, что в индексе отсутствуют, — а затем
 * каждая проверяется запросом. Зашитый список молча устареет при появлении
 * новой службы, и это не будет видно ничем.
 */
const KNOWN_MISSING_FROM_INDEX = [
  'vcards',
  'smartadtargets',
  'dynamictextadtargets',
  'dynamicfeedadtargets',
];

/**
 * Разделы документации, заведомо не являющиеся службами.
 *
 * Список НАМЕРЕННО не используется для решения «служба или нет» — только для
 * того, чтобы не дёргать API заведомо зря. Принадлежность решает ответ на
 * запрос WSDL, и это не педантизм: первая редакция решала по списку, и в нём
 * по ошибке оказалась `strategies` — настоящая служба с 70 КБ схемы и пятью
 * операциями. Спека собралась, тесты прошли, счёт сошёлся сам с собой, и
 * пропажа целой службы не подала ни одного признака. Список из головы
 * устаревает молча; запрос — нет.
 */
const UNLIKELY_SERVICE = new Set(['objects', 'concepts', 'best-practice', 'troubleshooting', 'annex']);

async function get(url, { binary = false } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} на ${url}`);
  return binary ? Buffer.from(await res.arrayBuffer()) : res.text();
}

/** Страницы вида .../doc/ru/<служба>/<метод>.md — это и есть справочник методов. */
export function docPages(llms) {
  const found = new Map();
  for (const [, path] of llms.matchAll(/https:\/\/yandex\.ru\/dev\/direct\/doc\/ru\/([a-z0-9/_-]+)\.md/g)) {
    const parts = path.split('/');
    if (parts.length !== 2) continue;
    const [service, method] = parts;
    if (!found.has(service)) found.set(service, []);
    found.get(service).push(method);
  }
  return found;
}

async function write(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

async function main() {
  const llms = await get(LLMS_URL);
  await write(join(CACHE_DIR, 'llms.txt'), llms);

  const fromDocs = docPages(llms);
  const candidates = [...new Set([...fromDocs.keys(), ...KNOWN_MISSING_FROM_INDEX])]
    .filter((s) => !UNLIKELY_SERVICE.has(s))
    .sort();
  const services = candidates;
  console.error(`кандидатов к проверке: ${services.length} (разделов в индексе ${fromDocs.size})`);

  const wsdl = [];
  const noWsdl = [];
  for (const service of services) {
    try {
      const xml = await get(WSDL_URL(service));
      if (xml.length < 1000) throw new Error(`подозрительно короткий ответ (${xml.length} байт)`);
      await write(join(CACHE_DIR, 'wsdl', `${service}.wsdl`), xml);
      wsdl.push({ service, bytes: xml.length });
    } catch (e) {
      noWsdl.push({ service, reason: String(e.message) });
    }
  }

  /**
   * Общие типы лежат ВНЕ WSDL — в отдельных XSD, на которые тот ссылается
   * (general.xsd, generalclients.xsd, adextensiontypes.xsd). Без них граф типов
   * обрывается: `gc:ClientGetItem` из ответа clients.get определён не в WSDL.
   * Адреса собираем из самих файлов, а не зашиваем: зашитый список не заметит,
   * когда Яндекс добавит четвёртый.
   */
  const imports = new Set([
    // Служба reports WSDL не отдаёт, но её схема лежит отдельным файлом и
    // содержит перечисления, без которых инструмент отчётов не может назвать
    // модели ни допустимые типы отчётов, ни периоды, ни колонки.
    'https://soap.direct.yandex.ru/v5/reports.xsd',
  ]);
  for (const { service } of wsdl) {
    const xml = await readFile(join(CACHE_DIR, 'wsdl', `${service}.wsdl`), 'utf8');
    for (const [, loc] of xml.matchAll(/schemaLocation="([^"]+)"/g)) imports.add(loc);
  }
  const xsd = [];
  for (const url of imports) {
    const name = url.split('/').pop();
    const body = await get(url);
    await write(join(CACHE_DIR, 'xsd', name), body);
    xsd.push({ name, bytes: body.length });
  }

  const docs = [];
  for (const [service, methods] of fromDocs) {
    for (const method of methods) {
      const url = `https://yandex.ru/dev/direct/doc/ru/${service}/${method}.md`;
      try {
        const md = await get(url);
        await write(join(CACHE_DIR, 'docs', service, `${method}.md`), md);
        docs.push(`${service}/${method}`);
      } catch {
        /* отсутствующая страница — не отказ сборки: состав берётся из WSDL */
      }
    }
  }

  const manifest = {
    fetchedFrom: { llms: LLMS_URL, wsdl: WSDL_URL('<service>') },
    services: wsdl.map((w) => w.service),
    wsdlBytes: Object.fromEntries(wsdl.map((w) => [w.service, w.bytes])),
    withoutWsdl: noWsdl,
    sharedSchemas: xsd,
    docPages: docs.length,
  };
  await write(join(CACHE_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.error(`WSDL получен: ${wsdl.length} служб`);
  console.error(`без WSDL: ${noWsdl.map((n) => n.service).join(', ') || '—'}`);
  console.error(`общих схем: ${xsd.length} (${xsd.map((x) => x.name).join(', ')})`);
  console.error(`страниц документации: ${docs.length}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}

export { get, main };
