#!/usr/bin/env node
/**
 * Прогон собранного сервера против живого API.
 *
 * Смысл именно в этом слове — собранного. Модульные тесты проверяют части на
 * заглушках; здесь запускается тот самый файл, который запустит клиент, и
 * разговор идёт по тому же протоколу. Только так видно, что путь целиком
 * замкнулся: схема, транспорт, разбор, единицы.
 *
 * Только читающие вызовы. Токен берётся из окружения и не печатается.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../build/index.js', import.meta.url));

const token = process.env.YANDEX_DIRECT_TOKEN ?? process.env.YANDEX_API_KEY;
if (!token) {
  console.error('нужен YANDEX_DIRECT_TOKEN или YANDEX_API_KEY в окружении');
  process.exit(2);
}

const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, YANDEX_DIRECT_TOKEN: token },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (c) => (stderr += c));

const pending = new Map();
let nextId = 1;
let buffer = '';

child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => reject(new Error(`нет ответа на ${method}`)), 180_000);
  });

const notify = (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);

const body = (res) => {
  const t = res.result?.content?.[0]?.text ?? '';
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

try {
  const init = await call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0' },
  });
  notify('notifications/initialized');
  check('рукопожатие', Boolean(init.result?.serverInfo), init.result?.serverInfo?.version);

  const list = await call('tools/list', {});
  const tools = list.result?.tools ?? [];
  check('инструменты объявлены', tools.length > 0, `${tools.length} шт.`);

  // 1. Обычная служба: сквозной путь схема → транспорт → разбор.
  const camps = await call('tools/call', {
    name: 'direct_campaigns_get',
    arguments: { FieldNames: ['Id', 'Name', 'State', 'Type'], Page: { Limit: 3 } },
  });
  const c = body(camps);
  const rows = c?.данные?.Campaigns ?? [];
  check('campaigns.get отвечает', rows.length > 0, `кампаний ${rows.length}`);
  check('баллы посчитаны', Boolean(c?._мета?.баллы), c?._мета?.баллы);
  check('версия пути названа', Boolean(c?._мета?.версия_api), c?._мета?.версия_api);

  // 2. Деньги: то самое место, где ошибка была бы ровно в миллион раз.
  const funds = await call('tools/call', {
    name: 'direct_campaigns_get',
    arguments: { FieldNames: ['Id', 'DailyBudget'], Page: { Limit: 5 } },
  });
  const f = body(funds);
  const budgets = (f?.данные?.Campaigns ?? [])
    .map((x) => x?.DailyBudget?.Amount)
    .filter((x) => typeof x === 'number');
  const sane = budgets.every((b) => b < 10_000_000);
  check(
    'суммы приведены к рублям',
    budgets.length === 0 || sane,
    budgets.length ? `бюджеты: ${budgets.slice(0, 3).join(', ')}` : 'бюджеты не заданы',
  );
  if (f?._мета?.суммы_переведены_из_микроединиц) {
    check('пересчёт назван в ответе', true, f._мета.суммы_переведены_из_микроединиц.join(', '));
  }

  // 3. Отчёт: асинхронный протокол с опросом, самый длинный путь.
  const rep = await call('tools/call', {
    name: 'direct_reports_get',
    arguments: {
      ReportType: 'CAMPAIGN_PERFORMANCE_REPORT',
      FieldNames: ['CampaignId', 'Impressions', 'Clicks', 'Cost'],
      DateRangeType: 'LAST_30_DAYS',
    },
  });
  const r = body(rep);
  const reportRows = r?.данные?.rows ?? [];
  check('отчёт собран', reportRows.length > 0, `строк ${reportRows.length}`);
  const costs = reportRows.map((x) => x.Cost).filter((x) => typeof x === 'number');
  check(
    'расход в рублях, а не в микро-единицах',
    costs.length > 0 && costs.every((x) => x < 1_000_000),
    costs.length ? `максимум ${Math.max(...costs)}` : 'нет строк',
  );

  // 4. Отказ остаётся отказом.
  const bad = await call('tools/call', {
    name: 'direct_campaigns_get',
    arguments: { FieldNames: ['ЗаведомоНеверноеПоле'] },
  });
  check('неверное поле даёт ошибку, а не пустой успех', bad.result?.isError === true,
    String(bad.result?.content?.[0]?.text ?? '').slice(0, 80));

  // 5. Каталог рассказывает про скрытое.
  const cat = await call('tools/call', { name: 'direct_catalog', arguments: {} });
  const k = body(cat);
  check('каталог знает про скрытое', (k?.всего_в_api ?? 0) > (k?.объявлено ?? 0),
    `объявлено ${k?.объявлено} из ${k?.всего_в_api}`);
} catch (e) {
  console.error('прогон оборвался:', e.message);
  console.error('stderr сервера:', stderr.slice(0, 600));
  failures++;
} finally {
  child.kill();
}

console.log(failures ? `\nпровалов: ${failures}` : '\nвсё сошлось');
process.exit(failures ? 1 : 0);
