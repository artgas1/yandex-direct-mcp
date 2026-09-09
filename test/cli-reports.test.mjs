import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { runCli } from '../build/cli.js';

/**
 * Сторож обязательных полей отчёта в режиме командной строки.
 *
 * Дефект нашёлся не тестом, а настоящей задачей: MCP-инструмент подставлял
 * IncludeVAT, а CLI — нет, и запрос отбивался кодом 8000. Ни справка, ни
 * describe об этом не сообщали, потому что в схеме поле необязательное:
 * обязательным его делает сама служба отчётов.
 */
let server;
let lastBody = null;

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      lastBody = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'text/tsv' });
      res.end('CampaignId\tImpressions\n100\t7\n');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.DIRECT_API_BASE = `http://127.0.0.1:${server.address().port}/json/v501/`;
});

after(async () => {
  delete process.env.DIRECT_API_BASE;
  await new Promise((r) => server.close(r));
});

const io = () => {
  const out = [];
  return { out: (l) => out.push(l), err: (l) => out.push(l), lines: out };
};

test('CLI сам подставляет IncludeVAT — без него служба отчётов отказывает', async () => {
  const sink = io();
  const saved = process.env.YANDEX_DIRECT_TOKEN;
  process.env.YANDEX_DIRECT_TOKEN = 'x'.repeat(40);
  try {
    const code = await runCli(
      ['call', 'reports.get', '--ReportType', 'CAMPAIGN_PERFORMANCE_REPORT', '--FieldNames', 'CampaignId'],
      sink,
    );
    assert.equal(code, 0, sink.lines.join('\n').slice(0, 300));
  } finally {
    if (saved === undefined) delete process.env.YANDEX_DIRECT_TOKEN;
    else process.env.YANDEX_DIRECT_TOKEN = saved;
  }
  assert.equal(lastBody.params.IncludeVAT, 'YES');
  assert.equal(lastBody.params.Format, 'TSV');
  assert.ok(lastBody.params.ReportName, 'без ReportName повтор не найдёт поставленную задачу');
});

test('явно заданное значение побеждает умолчание', async () => {
  const sink = io();
  const saved = process.env.YANDEX_DIRECT_TOKEN;
  process.env.YANDEX_DIRECT_TOKEN = 'x'.repeat(40);
  try {
    await runCli(
      ['call', 'reports.get', '--ReportType', 'CUSTOM_REPORT', '--FieldNames', 'CampaignId',
       '--IncludeVAT', 'NO', '--DateRangeType', 'LAST_7_DAYS'],
      sink,
    );
  } finally {
    if (saved === undefined) delete process.env.YANDEX_DIRECT_TOKEN;
    else process.env.YANDEX_DIRECT_TOKEN = saved;
  }
  assert.equal(lastBody.params.IncludeVAT, 'NO');
  assert.equal(lastBody.params.DateRangeType, 'LAST_7_DAYS');
});
