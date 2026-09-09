import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { loadSpec } from '../build/spec.js';
import { annotate, isWrite } from '../build/annotations.js';
import { CORE_TOOLS, resolveSurface } from '../build/profiles.js';
import { summarizeResults, unwrapItems, versionNotes, wireValue } from '../build/tools.js';
import { moneyFields, normalizeMoney, toMicro } from '../build/money.js';

const spec = loadSpec();

test('спека разобралась полностью', () => {
  assert.equal(spec.problems.length, 0, spec.problems.join('; '));
  assert.equal(spec.methods.length, spec.counts.methods);
  assert.ok(spec.methods.length >= 113, `методов ${spec.methods.length}, ожидалось не меньше 113`);
});

test('служба strategies на месте', () => {
  // Сторож пропажи: первая редакция генератора отбрасывала strategies по
  // рукописному списку исключений, и спека собиралась без неё молча.
  const ops = spec.methods.filter((m) => m.service === 'strategies').map((m) => m.operation);
  assert.deepEqual(ops.sort(), ['add', 'archive', 'get', 'unarchive', 'update']);
});

test('ни у одной операции get не пустая схема запроса', () => {
  // Сторож наследования: get объявлен через xsd:extension, и разбор без
  // разворачивания оставлял двадцать пять схем пустыми, не подав признака.
  const empty = spec.methods.filter(
    (m) => m.operation === 'get' && Array.isArray(m.request) && m.request.length === 0,
  );
  assert.deepEqual(empty.map((m) => m.tool), []);
});

test('постраничность доехала из базового типа', () => {
  const get = spec.methods.find((m) => m.tool === 'direct_campaigns_get');
  assert.ok(get.request.some((f) => f.name === 'Page'), 'без Page выборка молча обрезается');
});

test('каждый инструмент имеет непустое описание', () => {
  const mute = spec.methods.filter((m) => !m.summary && !m.title);
  assert.deepEqual(mute.map((m) => m.tool), []);
});

test('меняющие данные инструменты не объявляются без разрешения', () => {
  const closed = resolveSurface({ profile: 'all', allowWrites: false });
  const opened = resolveSurface({ profile: 'all', allowWrites: true });
  const writes = spec.methods.filter(isWrite);
  assert.ok(writes.length > 60, `меняющих методов ${writes.length}`);
  assert.equal(writes.filter((m) => closed.include(m)).length, 0);
  assert.equal(writes.filter((m) => opened.include(m)).length, writes.length);
});

test('профиль по умолчанию — узкий и только читающий', () => {
  const core = resolveSurface({ allowWrites: false });
  const shown = spec.methods.filter((m) => core.include(m));
  assert.equal(shown.length, CORE_TOOLS.length);
  assert.equal(shown.filter(isWrite).length, 0);
  assert.ok(shown.some((m) => m.tool === 'direct_reports_get'), 'отчёт обязан быть в умолчании');
});

test('аннотации отражают характер операции', () => {
  const get = spec.methods.find((m) => m.tool === 'direct_campaigns_get');
  const del = spec.methods.find((m) => m.tool === 'direct_campaigns_delete');
  const add = spec.methods.find((m) => m.tool === 'direct_campaigns_add');
  assert.equal(annotate(get).readOnlyHint, true);
  assert.equal(annotate(del).destructiveHint, true);
  assert.equal(annotate(add).idempotentHint, false, 'повтор add создаёт второй объект');
});

test('деньги: чтение делит на миллион, запись умножает', () => {
  const money = moneyFields(spec);
  assert.ok(money.has('Amount') && money.has('Bid'));
  assert.ok(!money.has('Clicks') && !money.has('Impressions'), 'счётчики деньгами не являются');

  // Множитель — миллион: 1000000000 микро-единиц это 1000 единиц валюты счёта.
  const { value, converted } = normalizeMoney({ DailyBudget: { Amount: 1000000000 } }, money);
  assert.equal(value.DailyBudget.Amount, 1000);
  assert.deepEqual(converted, ['Amount']);

  assert.equal(toMicro({ Bid: 30.5 }, money).Bid, 30500000);
});

test('обёртка Items ставится и снимается по типу, а не по виду значения', () => {
  const method = spec.methods.find((m) => m.tool === 'direct_adgroups_get');
  const money = moneyFields(spec);

  // RegionIds объявлен как maxOccurs=unbounded — на проводе голый массив.
  // RestrictedRegionIds объявлен типом ArrayOfLong — на проводе {"Items": [...]}.
  const type = spec.types.AdGroupGetItem;
  const region = type.fields.find((f) => f.name === 'RegionIds');
  const restricted = type.fields.find((f) => f.name === 'RestrictedRegionIds');
  assert.equal(region.type, 'long');
  assert.equal(region.array, true);
  assert.equal(restricted.type, 'ArrayOfLong');

  // Круг замкнут: развернули на чтении, завернули на записи.
  const read = unwrapItems({ RestrictedRegionIds: { Items: [225] }, RegionIds: [225, 977] });
  assert.deepEqual(read, { RestrictedRegionIds: [225], RegionIds: [225, 977] });

  const addMethod = spec.methods.find((m) => m.tool === 'direct_campaigns_add');
  const wire = wireValue({ Campaigns: [{ Id: 1 }] }, addMethod, spec, money);
  assert.ok(wire.Campaigns, 'массив unbounded остаётся голым');
});

test('предупреждения — это применено, а не отклонено', () => {
  // Отрицательный контроль: счёт по наличию любого содержимого в элементе
  // прочитал бы записи с Warnings как отказы, хотя они применены.
  const summary = summarizeResults({
    UpdateResults: [
      { Id: 1, Warnings: [{ Code: 10172 }] },
      { Id: 2 },
      { Errors: [{ Code: 8000 }] },
    ],
  });
  assert.match(summary, /применено 2/);
  assert.match(summary, /отклонено 1/);
  assert.match(summary, /предупреждениями 1/);
});

test('несовпадение версии и набора глубоких полей называется вслух', () => {
  const before = process.env.DIRECT_API_VERSION;
  try {
    process.env.DIRECT_API_VERSION = 'v501';
    const notes = versionNotes({ TextCampaignFieldNames: ['BiddingStrategy'] });
    assert.equal(notes.length, 1);
    assert.match(notes[0], /НЕ вернёт глубокие поля/);

    // Отрицательный контроль: верный набор предупреждения не порождает.
    assert.deepEqual(versionNotes({ UnifiedCampaignFieldNames: ['BiddingStrategy'] }), []);

    process.env.DIRECT_API_VERSION = 'v5';
    assert.equal(versionNotes({ TextCampaignFieldNames: ['x'] }).length, 0);
    assert.equal(versionNotes({ UnifiedCampaignFieldNames: ['x'] }).length, 1);
  } finally {
    if (before === undefined) delete process.env.DIRECT_API_VERSION;
    else process.env.DIRECT_API_VERSION = before;
  }
});

test('неизвестный профиль отбивается с перечислением допустимых', () => {
  assert.throws(() => resolveSurface({ profile: 'полный', allowWrites: false }), /core, read, all/);
});
