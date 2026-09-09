import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startServer } from '../tools/mcp-client.mjs';

/**
 * Ловит один отказ: сервер сообщает при старте одно число инструментов, а в
 * tools/list их другое. Он молчаливый — баннер выглядит правдоподобно, и
 * сравнить его можно только с ответом сервера.
 *
 * Так и было в 1.1.0: «инструментов 10 из 113» при тринадцати объявленных.
 * Счётчик считал методы API плюс сводку, а direct_fields, direct_schema и
 * direct_catalog не попадали в него вовсе. Ни типизация, ни линтер этого не
 * видят: обе величины — целые числа, и обе «работают».
 *
 * Отрицательный контроль: верните `count++` после registerInventory или
 * подмените `declared` на любую отдельную переменную — тест назовёт разницу.
 */

const TOKEN = `y0_${'x'.repeat(60)}`;

async function surfaceOf(env) {
  const server = startServer({ YANDEX_DIRECT_TOKEN: TOKEN, ...env });
  try {
    await server.initialize('banner-test');
    const tools = await server.listTools();
    return { tools, banner: server.stderr().split('\n')[0] };
  } finally {
    server.stop();
  }
}

test('баннер старта называет столько же инструментов, сколько в tools/list', async () => {
  const { tools, banner } = await surfaceOf({});
  const declared = Number(/инструментов (\d+)/.exec(banner)?.[1]);
  assert.ok(Number.isInteger(declared), `в баннере нет числа инструментов: ${banner}`);
  assert.equal(
    declared,
    tools.length,
    `баннер сообщает ${declared} инструментов, а tools/list отдаёт ${tools.length}`,
  );
});

test('баннер разделяет методы API и служебные инструменты', async () => {
  const { tools, banner } = await surfaceOf({});
  const m = /методов API (\d+) из (\d+) и служебных (\d+)/.exec(banner);
  assert.ok(m, `баннер не разделяет совокупности: ${banner}`);
  const [, api, total, helpers] = m.map(Number);

  // Отношение в баннере обязано быть отношением одной совокупности: методы к
  // методам. Служебных инструментов в спеке API нет вовсе.
  assert.ok(api <= total, `методов API объявлено ${api} из ${total} — больше, чем есть`);
  assert.equal(
    api + helpers,
    tools.length,
    `${api} методов и ${helpers} служебных не складываются в ${tools.length}`,
  );

  const names = tools.map((t) => t.name);
  const helperNames = names.filter((n) => !/^direct_[a-z]+_[a-z]/.test(n));
  assert.equal(
    helperNames.length,
    helpers,
    `служебными названы ${helpers}, а по именам их ${helperNames.length}: ${helperNames}`,
  );
});

test('профиль all объявляет больше, и баннер это отражает', async () => {
  const { tools, banner } = await surfaceOf({ DIRECT_PROFILE: 'all' });
  const declared = Number(/инструментов (\d+)/.exec(banner)?.[1]);
  assert.equal(declared, tools.length, `all: баннер ${declared}, tools/list ${tools.length}`);
  assert.ok(tools.length > 13, `профиль all обязан объявлять больше умолчания, а объявил ${tools.length}`);
});
