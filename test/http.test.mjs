import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { DirectApiError, callDirect, errorOf, parseUnits, tokenProblem } from '../build/http.js';

/**
 * Заглушка вместо сети. Коды, структура тела ошибки и формат заголовка Units
 * повторяют поведение живого API; значения в фикстурах синтетические.
 */
let server;
let route = () => ({ status: 200, body: '{}', headers: {} });

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const r = route(req, raw);
      res.writeHead(r.status, { 'Content-Type': 'application/json', ...r.headers });
      res.end(r.body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.DIRECT_API_BASE = `http://127.0.0.1:${server.address().port}/json/v5/`;
});

after(async () => {
  delete process.env.DIRECT_API_BASE;
  await new Promise((r) => server.close(r));
});

test('ошибка при HTTP 200 распознаётся как отказ', async () => {
  route = () => ({
    status: 200,
    headers: { Units: '50/998050/1000000' },
    body: JSON.stringify({
      error: {
        request_id: '1111111111111111111',
        error_code: 8000,
        error_detail: 'Элемент массива FieldNames содержит неверное значение перечисления',
        error_string: 'Некорректный запрос',
      },
    }),
  });

  await assert.rejects(
    () => callDirect({ service: 'campaigns', method: 'get', params: {}, token: 'x', retries: 0 }),
    (e) => {
      assert.ok(e instanceof DirectApiError);
      assert.equal(e.code, 8000);
      assert.equal(e.httpStatus, 200);
      assert.equal(e.units.left, 998050);
      return true;
    },
  );
});

test('ошибка при HTTP 202 распознаётся как отказ, а не как «принято»', async () => {
  // Отрицательный контроль ко всей конструкции: реализация, проверяющая res.ok
  // или status === 200, обе эти пробы пройдёт молча. Замер дал ровно 202.
  route = () => ({
    status: 202,
    body: JSON.stringify({
      error: {
        request_id: '2222222222222222222',
        error_code: 55,
        error_detail: 'Указано неверное значение ключа method',
        error_string: 'Операция не найдена',
      },
    }),
  });

  await assert.rejects(
    () => callDirect({ service: 'campaigns', method: 'nosuchmethod', params: {}, token: 'x', retries: 0 }),
    (e) => e instanceof DirectApiError && e.code === 55 && e.httpStatus === 202,
  );
});

test('успешный ответ сохраняет длинный Id строкой', async () => {
  route = () => ({
    status: 200,
    headers: { Units: '62/998000/1000000', RequestId: '123' },
    body: '{"result":{"Ads":[{"Id":1234567890123456789,"CampaignId":10000042}]}}',
  });

  const res = await callDirect({ service: 'ads', method: 'get', params: {}, token: 'x' });
  assert.equal(res.result.result.Ads[0].Id, '1234567890123456789');
  assert.equal(res.result.result.Ads[0].CampaignId, 10000042);
  assert.equal(res.units.spent, 62);
  assert.equal(res.requestId, '123');
});

test('тело reports передаётся без ключа method', async () => {
  let seen = null;
  route = (req, raw) => {
    seen = JSON.parse(raw);
    return { status: 200, body: 'CampaignId\tCost\n10000011\t640.00\n' };
  };

  await callDirect({ service: 'reports', params: { ReportName: 'x' }, token: 'x' });
  assert.deepEqual(Object.keys(seen), ['params'], 'у reports ключа method быть не должно');
});

test('обычная служба передаёт method', async () => {
  let seen = null;
  route = (req, raw) => {
    seen = JSON.parse(raw);
    return { status: 200, body: '{"result":{}}' };
  };

  await callDirect({ service: 'campaigns', method: 'get', params: {}, token: 'x' });
  assert.equal(seen.method, 'get');
});

test('Client-Login не отправляется, когда не задан', async () => {
  let headers = null;
  route = (req) => {
    headers = req.headers;
    return { status: 200, body: '{"result":{}}' };
  };

  await callDirect({ service: 'clients', method: 'get', params: {}, token: 'x' });
  assert.equal(headers['client-login'], undefined);

  await callDirect({ service: 'clients', method: 'get', params: {}, token: 'x', clientLogin: 'example-login' });
  assert.equal(headers['client-login'], 'example-login');
});

test('Units разбирается в потрачено/осталось/лимит', () => {
  assert.deepEqual(parseUnits('62/998000/1000000'), { spent: 62, left: 998000, limit: 1000000 });
  assert.equal(parseUnits(null), null);
  assert.equal(parseUnits('мусор'), null);
});

test('errorOf находит отказ независимо от статуса', () => {
  assert.equal(errorOf({ result: {} }), null);
  assert.equal(errorOf(null), null);
  assert.equal(errorOf({ error: { error_code: 53 } }).error_code, 53);
});

test('токен с кириллицей отбивается до сети', () => {
  assert.equal(tokenProblem('y0_AgAAAAA'), null);
  const problem = tokenProblem('y0_АgAAAAA'); // «А» здесь кириллическая
  assert.ok(problem);
  assert.match(problem, /U\+0410/);
});
