import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { exceedsSafeRange, parseExact, quoteUnsafeIntegers } from '../build/json.js';

/**
 * Девятнадцатизначный идентификатор — ровно та длина, которую Директ выдаёт
 * объявлениям на самом деле (длина сверена с живым API; само значение
 * синтетическое). Круглое число тут не годится: потеря точности съедает
 * именно младшие значащие цифры, и на ...000 дефект не воспроизводится.
 */
const LONG_AD_ID = '1234567890123456789';

test('отрицательный контроль: голый JSON.parse портит девятнадцатизначный Id', () => {
  const corrupted = JSON.parse(`{"Id":${LONG_AD_ID}}`).Id;
  assert.notEqual(
    String(corrupted),
    LONG_AD_ID,
    'если этот разбор перестал портить число, дефекта больше нет и модуль json.ts не нужен',
  );
  assert.equal(String(corrupted), '1234567890123456800');
});

test('parseExact сохраняет Id объявления точно', () => {
  const parsed = parseExact(`{"result":{"Ads":[{"Id":${LONG_AD_ID},"CampaignId":10000042}]}}`);
  assert.equal(parsed.result.Ads[0].Id, LONG_AD_ID);
  assert.equal(typeof parsed.result.Ads[0].Id, 'string');
});

test('числа в пределах точности остаются числами', () => {
  const parsed = parseExact('{"CampaignId":10000042,"Bid":30000000,"Clicks":80}');
  assert.equal(parsed.CampaignId, 10000042);
  assert.equal(typeof parsed.CampaignId, 'number');
  assert.equal(typeof parsed.Bid, 'number');
});

test('цифры внутри строки не трогаются', () => {
  const parsed = parseExact(`{"Name":"Кампания ${LONG_AD_ID} на поиске","Id":${LONG_AD_ID}}`);
  assert.equal(parsed.Name, `Кампания ${LONG_AD_ID} на поиске`);
  assert.equal(parsed.Id, LONG_AD_ID);
});

test('экранированная кавычка внутри строки не сбивает сканер', () => {
  const parsed = parseExact(`{"Name":"скидка \\"50%\\" тут","Id":${LONG_AD_ID}}`);
  assert.equal(parsed.Name, 'скидка "50%" тут');
  assert.equal(parsed.Id, LONG_AD_ID);
});

test('дробные и экспоненциальные остаются числами', () => {
  const parsed = parseExact('{"Ctr":8.5,"Rate":1e21,"Neg":-0.5}');
  assert.equal(typeof parsed.Ctr, 'number');
  assert.equal(typeof parsed.Rate, 'number');
  assert.equal(parsed.Neg, -0.5);
});

test('отрицательное длинное целое тоже сохраняется', () => {
  const parsed = parseExact(`{"Delta":-${LONG_AD_ID}}`);
  assert.equal(parsed.Delta, `-${LONG_AD_ID}`);
});

test('граница диапазона проходит ровно по MAX_SAFE_INTEGER', () => {
  assert.equal(exceedsSafeRange('9007199254740991'), false);
  assert.equal(exceedsSafeRange('9007199254740992'), true);
  assert.equal(exceedsSafeRange('-9007199254740992'), true);
  assert.equal(exceedsSafeRange('10000042'), false);
});

test('разбор не меняет тело, в котором нечего чинить', () => {
  const src = '{"result":{"Campaigns":[{"Id":10000042,"Name":"Поиск"}]}}';
  assert.equal(quoteUnsafeIntegers(src), src);
});
