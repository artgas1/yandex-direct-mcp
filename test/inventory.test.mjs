import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { defaultWindow, merge } from '../build/inventory.js';

/**
 * Расхождение не выдумано: кампании Мастера кампаний не возвращаются методом
 * campaigns.get — ни списком, ни по явному Ids, — но присутствуют в отчёте.
 * Идентификаторы и числа ниже синтетические.
 */

test('кампания из отчёта, которой нет в списке, помечается и не теряется', () => {
  const listed = [
    { Id: 10000011, Name: 'Поиск', Type: 'TEXT_CAMPAIGN', State: 'ON' },
    { Id: 10000023, Name: 'РСЯ', Type: 'TEXT_CAMPAIGN', State: 'ON' },
  ];
  const reported = [
    { CampaignId: 10000011, CampaignName: 'Поиск', Impressions: 1000, Clicks: 80, Cost: 640 },
    { CampaignId: 10000017, CampaignName: 'кампания вне списка', Impressions: 33000, Clicks: 930, Cost: 1234.50 },
  ];

  const { rows, onlyReport, onlyList } = merge(listed, reported);

  assert.equal(rows.length, 3, 'объединение обязано дать три кампании, а не две');
  assert.deepEqual(onlyReport, ['10000017']);
  assert.deepEqual(onlyList, ['10000023']);

  // Отрицательный контроль ко всему инструменту: если склейка когда-нибудь
  // начнёт брать состав только из списка, кампания, невидимая для
  // campaigns.get, исчезнет вместе со своими показами.
  const hidden = rows.find((r) => r.Id === '10000017');
  assert.ok(hidden, 'кампания, невидимая для campaigns.get, потеряна');
  assert.equal(hidden.источник, 'только отчёт');
  assert.equal(hidden.Impressions, 33000);
});

test('строки сортируются по показам — крупное сверху', () => {
  const { rows } = merge(
    [{ Id: 1, Name: 'малая' }],
    [
      { CampaignId: 1, Impressions: 10 },
      { CampaignId: 2, CampaignName: 'крупная', Impressions: 1000 },
    ],
  );
  assert.equal(rows[0].Id, '2');
});

test('несколько строк отчёта по одной кампании складываются', () => {
  const { rows } = merge(
    [{ Id: 5, Name: 'дневная разбивка' }],
    [
      { CampaignId: 5, Impressions: 100, Clicks: 10, Cost: 50 },
      { CampaignId: 5, Impressions: 200, Clicks: 20, Cost: 70 },
    ],
  );
  assert.equal(rows[0].Impressions, 300);
  assert.equal(rows[0].Clicks, 30);
  assert.equal(rows[0].Cost, 120);
  assert.equal(rows[0].источник, 'список и отчёт');
});

test('идентификатор сравнивается как строка — длинные не схлопываются', () => {
  const { rows } = merge(
    [{ Id: '1234567890123456789', Name: 'длинный' }],
    [{ CampaignId: '1234567890123456789', Impressions: 7 }],
  );
  assert.equal(rows.length, 1, 'строка и число одного идентификатора должны совпасть');
  assert.equal(rows[0].Impressions, 7);
});

test('окно по умолчанию заканчивается вчера, а не сегодня', () => {
  // Сегодняшний день в отчётах неполон, и включать его — значит занижать
  // последние сутки, не подавая об этом признака.
  const { from, to } = defaultWindow(new Date('2026-09-09T12:00:00Z'));
  assert.equal(to, '2026-09-08');
  assert.equal(from, '2026-08-10');
});
