import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { markdown, rows } from '../tools/coverage.mjs';

/**
 * Ловит один отказ: спека пересобралась, состав API поменялся, а числа в README
 * остались прежними. Он молчаливый — устаревшая таблица выглядит ровно как
 * верная, — и в этом репозитории уже случался трижды: счётчики типов, кратность
 * веса поверхности, число проверок. Ни типизация, ни линтер прозу не читают.
 *
 * Отрицательный контроль осмыслен: поправьте в README любое число — тест упадёт
 * и назовёт, какое именно.
 */

const ru = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const en = readFileSync(new URL('../README.en.md', import.meta.url), 'utf8');
const svg = readFileSync(new URL('../assets/surface.svg', import.meta.url), 'utf8');

const BOTH = [
  ['README.md', ru],
  ['README.en.md', en],
];

/** Разряды печатаются то обычным пробелом, то неразрывным — сравниваем цифры. */
const digits = (text) => text.replace(/[\s  ]/g, '');

test('таблица покрытия в README совпадает со спекой', async () => {
  const r = await rows();
  assert.ok(
    ru.includes(markdown(r)),
    'таблица покрытия в README.md разошлась со спекой — пересоберите: npm run coverage',
  );
});

test('итоговые числа названы в обоих README', async () => {
  const { totalMethods, totalServices, totalCore } = await rows();
  for (const [name, text] of BOTH) {
    assert.ok(text.includes(`**${totalMethods}**`), `${name}: не назвал ${totalMethods} методов`);
    assert.ok(text.includes(`**${totalServices}**`), `${name}: не назвал ${totalServices} служб`);
    assert.ok(text.includes(`**${totalCore}**`), `${name}: не назвал ${totalCore} в core`);
  }
});

test('вес поверхности на графике и в README — одни и те же числа', () => {
  const weights = [...svg.matchAll(/>([\d\s  ]{3,}) Б</g)].map((m) =>
    Number(digits(m[1])),
  );
  assert.equal(weights.length, 2, 'на графике должно быть два веса: полный каталог и умолчание');
  const [all, core] = weights;
  assert.ok(all > core, 'полный каталог обязан быть тяжелее умолчания');

  const readme = digits(ru);
  for (const n of [all, core]) {
    assert.ok(
      readme.includes(digits(n.toLocaleString('ru-RU'))),
      `README.md не называет вес ${n}, который стоит на графике поверхности`,
    );
  }
});

test('графика поверхности подключена, и рядом стоит замер', () => {
  for (const [name, text] of BOTH) {
    // В разметку идёт GIF: он отрисовывается всюду, где вообще показывают
    // картинки, а README едет не только на GitHub. SVG остаётся источником.
    assert.match(text, /assets\/surface\.gif/, `${name}: графика поверхности не подключена`);
    // Картинка не должна быть единственным носителем факта — рядом обязана
    // стоять таблица замера tools/list.
    assert.match(text, /tools\/list/, `${name}: рядом с графикой нет замера tools/list`);
  }
  assert.ok(svg.startsWith('<svg'), 'вектор-источник assets/surface.svg должен лежать в репозитории');
});

test('строка mcp-name на месте — по ней сервер находят в реестре', () => {
  for (const [name, text] of BOTH) {
    assert.ok(
      text.includes('mcp-name: io.github.artgas1/yandex-direct-api-mcp'),
      `${name}: нет строки mcp-name`,
    );
  }
});

test('число тестов в README совпадает с числом тестов', () => {
  // Ровно этот дефект нашёлся при добавлении проверок: README говорил «58»,
  // тестов было 66. Считаем так же, как их считает node --test: по объявлениям
  // верхнего уровня.
  const dir = new URL('./', import.meta.url);
  const actual = readdirSync(dir)
    .filter((f) => f.endsWith('.test.mjs'))
    .reduce(
      (n, f) => n + (readFileSync(new URL(f, dir), 'utf8').match(/^test\(/gm) ?? []).length,
      0,
    );
  for (const [name, text] of BOTH) {
    const claimed = /npm test\s+# (\d+) (?:тестов|tests)/.exec(text)?.[1];
    assert.ok(claimed, `${name}: не нашёл, сколько тестов заявлено`);
    assert.equal(
      Number(claimed),
      actual,
      `${name} заявляет ${claimed} тестов, а их ${actual}`,
    );
  }
});

test('alt-текст графики называет те же числа, что и она сама', () => {
  const alt = /<img[^>]*surface\.gif[^>]*alt="([^"]+)"/.exec(ru)?.[1];
  assert.ok(alt, 'у графики поверхности нет alt-текста');
  assert.ok(digits(alt).includes('113'), 'alt не называет полное число методов');
  assert.ok(digits(alt).includes('104'), 'alt не называет число вычеркнутых');
});
