#!/usr/bin/env node
/**
 * Живой прогон: что отдаёт Директ и что после этого отдаёт сервер.
 *
 * Показываются места, где прямой запрос ошибается МОЛЧА, — и обе колонки
 * настоящие. Левая получена так, как её получил бы обычный клиент: тело
 * заглушки разобрано голым `JSON.parse`. Правая — то, что вернул сервер по
 * JSON-RPC. Ничего не вписано руками, поэтому демо не может разойтись с
 * поведением: сломается поведение — сломается и картинка.
 *
 * Строка с идентификатором самодоказательна: слева он появляется испорченным
 * не потому, что так задумано, а потому что его действительно портит разбор.
 *
 * Токен и сеть не нужны: запросы уводятся на локальную заглушку через
 * DIRECT_API_BASE, поэтому прогон воспроизводится где угодно, включая CI.
 * Все значения в заглушке синтетические.
 *
 * Запуск: node tools/demo.mjs   (через npm run demo)
 * Запись: vhs demo.tape         (через npm run demo:record)
 */
import { createServer } from 'node:http';
import { startServer } from './mcp-client.mjs';

const C = {
  dim: '[38;5;245m',
  ink: '[38;5;252m',
  ya: '[38;5;203m',
  ok: '[38;5;114m',
  warn: '[38;5;179m',
  off: '[0m',
};

/** Длинный идентификатор: девятнадцать цифр — обычная длина для объявления. */
const LONG_ID = '1234567890123456789';

/** Ответ, который отдаёт Директ на самом деле: деньги в микро-единицах,
 *  длинное целое числом, список в обёртке. */
const RAW_OK = `{"result":{"Campaigns":[{"Id":${LONG_ID},"Name":"Поиск",` +
  `"DailyBudget":{"Amount":1000000000,"Mode":"STANDARD"},` +
  `"NegativeKeywords":{"Items":["бесплатно","отзывы"]}}]}}`;

/** И отказ, который приезжает с кодом 202 — а не с 4xx. */
const RAW_FAIL = '{"error":{"error_code":55,"error_string":"Операция не найдена",' +
  '"error_detail":"Указано неверное значение ключа method","request_id":"1111111111111111111"}}';

let mode = 'ok';
const stub = createServer((_req, res) => {
  const body = mode === 'ok' ? RAW_OK : RAW_FAIL;
  res.writeHead(mode === 'ok' ? 200 : 202, { 'content-type': 'application/json' });
  res.end(body);
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));

const client = startServer({
  YANDEX_DIRECT_TOKEN: 'demo',
  DIRECT_API_BASE: `http://127.0.0.1:${stub.address().port}/json/v501/`,
});

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].length));

try {
  await client.initialize('demo');

  const res = await client.callTool('direct_campaigns_get', {
    FieldNames: ['Id', 'Name', 'DailyBudget', 'NegativeKeywords'],
  });
  const camp = JSON.parse(res.content[0].text).данные.Campaigns[0];

  // Намеренно голый разбор — ровно то, что сделал бы обычный клиент.
  const raw = JSON.parse(RAW_OK).result.Campaigns[0];

  console.log(`\n  ${C.dim}вызов${C.off}  ${C.ya}direct_campaigns_get${C.off}\n`);
  console.log(
    `  ${C.dim}${pad('', 20)}${pad('голый JSON.parse', 26)}этот сервер${C.off}`,
  );

  const rows = [
    [
      'бюджет',
      String(raw.DailyBudget.Amount),
      String(camp.DailyBudget.Amount),
      'единицы валюты счёта',
    ],
    [
      'Id объявления',
      String(raw.Id),
      `"${camp.Id}"`,
      String(raw.Id) === String(camp.Id) ? 'совпало' : 'слева испорчен разбором',
    ],
    [
      'минус-фразы',
      '{"Items":[…]}',
      JSON.stringify(camp.NegativeKeywords),
      'обычный список',
    ],
  ];
  for (const [label, before, after, note] of rows) {
    console.log(
      `  ${C.ink}${pad(label, 20)}${C.off}${C.dim}${pad(before, 26)}${C.off}` +
        `${C.ok}${pad(after, 24)}${C.off}${C.dim}${note}${C.off}`,
    );
  }

  mode = 'fail';
  const bad = await client.callTool('direct_campaigns_get', { FieldNames: ['Id'] });
  const line = String(bad.content[0].text).split('\n')[0];
  console.log(
    `\n  ${C.ink}${pad('отказ с HTTP 202', 20)}${C.off}${C.dim}${pad('выглядит как «принято»', 26)}${C.off}` +
      `${C.warn}${line.slice(0, 24)}${C.off}\n`,
  );
} finally {
  client.stop();
  stub.close();
}
