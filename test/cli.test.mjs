import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CLI_COMMANDS, parseArgv, resolveMethod, runCli } from '../build/cli.js';
import { loadSpec } from '../build/spec.js';

const spec = loadSpec();

/** Собирает вывод вместо печати, чтобы проверять его целиком. */
function io() {
  const out = [];
  const err = [];
  return { out: (l) => out.push(l), err: (l) => err.push(l), lines: out, errors: err };
}

/** Прогон без сети: команды справочника отвечают из спеки в пакете. */
async function run(argv, env = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const sink = io();
  try {
    const code = await runCli(argv, sink);
    return { code, out: sink.lines.join('\n'), err: sink.errors.join('\n') };
  } finally {
    process.env = saved;
  }
}

test('разбор аргументов: значение, равенство, повтор, отрицание', () => {
  const a = parseArgv(['call', 'campaigns.get', '--FieldNames', 'Id', '--FieldNames', 'Name', '--Limit=5', '--no-vat']);
  assert.deepEqual(a.positional, ['call', 'campaigns.get']);
  assert.deepEqual(a.flags.FieldNames, ['Id', 'Name']);
  assert.equal(a.flags.Limit, '5');
  assert.equal(a.flags.vat, false);
});

test('флаг без значения — это истина, а не съеденный следующий флаг', () => {
  const a = parseArgv(['--verbose', '--service', 'ads']);
  assert.equal(a.flags.verbose, true);
  assert.equal(a.flags.service, 'ads');
});

test('имя метода узнаётся в трёх написаниях', () => {
  const canonical = resolveMethod(spec, 'campaigns.get');
  assert.ok(canonical);
  assert.equal(resolveMethod(spec, 'campaigns get')?.tool, canonical.tool);
  assert.equal(resolveMethod(spec, 'direct_campaigns_get')?.tool, canonical.tool);
  assert.equal(resolveMethod(spec, 'CAMPAIGNS.GET')?.tool, canonical.tool);
  assert.equal(resolveMethod(spec, 'такого.нет'), null);
});

test('справка и каталог отвечают без токена', async () => {
  const help = await run(['help'], { YANDEX_DIRECT_TOKEN: '', YANDEX_API_KEY: '' });
  assert.equal(help.code, 0);
  assert.match(help.out, /catalog/);

  const cat = await run(['catalog', '--service', 'clients'], { YANDEX_DIRECT_TOKEN: '', YANDEX_API_KEY: '' });
  assert.equal(cat.code, 0);
  assert.match(cat.out, /clients/);
});

test('describe печатает обязательные параметры', async () => {
  const res = await run(['describe', 'campaigns.suspend']);
  assert.equal(res.code, 0);
  assert.match(res.out, /SelectionCriteria/);
  assert.match(res.out, /обязательно/);
});

test('изменение запрещено без разрешения — код 3, и до сети дело не доходит', async () => {
  const res = await run(['call', 'campaigns.suspend', '--SelectionCriteria@json', '{"Ids":[1]}'], {
    DIRECT_ALLOW_WRITES: '',
    YANDEX_DIRECT_TOKEN: 'x'.repeat(40),
  });
  assert.equal(res.code, 3);
  assert.match(res.err, /DIRECT_ALLOW_WRITES/);
});

test('нет токена — код 4, а не попытка запроса', async () => {
  const res = await run(['call', 'campaigns.get', '--FieldNames', 'Id'], {
    YANDEX_DIRECT_TOKEN: '',
    YANDEX_API_KEY: '',
  });
  assert.equal(res.code, 4);
  assert.match(res.err, /direct:api/);
});

test('негодный токен отбивается до сети — код 4', async () => {
  const res = await run(['call', 'campaigns.get', '--FieldNames', 'Id'], {
    YANDEX_DIRECT_TOKEN: 'y0_АgAAAA', // «А» кириллическая
  });
  assert.equal(res.code, 4);
  assert.match(res.err, /U\+0410/);
});

test('неизвестный метод и неизвестная команда — код 2', async () => {
  assert.equal((await run(['call', 'такого.нет'])).code, 2);
  assert.equal((await run(['выдумка'])).code, 2);
});

test('негодный JSON в параметре — код 2 с указанием параметра', async () => {
  const res = await run(['call', 'campaigns.get', '--SelectionCriteria@json', '{не json}'], {
    YANDEX_DIRECT_TOKEN: 'x'.repeat(40),
  });
  assert.equal(res.code, 2);
  assert.match(res.err, /SelectionCriteria@json/);
});

test('fields отдаёт значения перечисления', async () => {
  const res = await run(['fields', 'CampaignFieldEnum']);
  assert.equal(res.code, 0);
  assert.match(res.out, /DailyBudget/);
});

test('список команд, уводящих в режим строки, замкнут', () => {
  // Клиент запускает сервер без аргументов, но может добавить свои; неизвестный
  // аргумент обязан остаться сервером, а не превратиться в справку на месте stdio.
  assert.ok(CLI_COMMANDS.has('call') && CLI_COMMANDS.has('catalog'));
  assert.ok(!CLI_COMMANDS.has('--port') && !CLI_COMMANDS.has('serve'));
});
