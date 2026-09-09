import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { CORE_TOOLS } from '../build/profiles.js';
import { loadSpec } from '../build/spec.js';

/**
 * Сторож бандла.
 *
 * Бандл — самостоятельная копия сервера, и копия расходится с оригиналом молча:
 * версия в манифесте отстаёт от package.json, список инструментов — от профиля,
 * и узнать об этом можно только на чужой машине. Здесь манифест собирается
 * заново и сверяется с теми же источниками, из которых работает сам сервер.
 *
 * Упаковку тест не делает — она ставит зависимости и занимает минуты.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

execFileSync(process.execPath, ['tools/build-mcpb.mjs'], { cwd: ROOT, stdio: 'pipe' });
const manifest = JSON.parse(readFileSync(`${ROOT}.mcpb-build/manifest.json`, 'utf8'));
const pkg = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8'));
const spec = loadSpec();

test('версия бандла не отстаёт от пакета', () => {
  assert.equal(manifest.version, pkg.version);
});

test('состав инструментов в манифесте — это профиль по умолчанию', () => {
  const declared = manifest.tools.map((t) => t.name);
  for (const t of CORE_TOOLS) {
    assert.ok(declared.includes(t), `в манифесте нет ${t} из профиля core`);
  }
  // Плюс составной инструмент и три справочных — ровно то, что объявляет сервер.
  assert.ok(declared.includes('direct_inventory'));
  assert.ok(declared.includes('direct_catalog'));
  assert.equal(declared.length, CORE_TOOLS.length + 4);
});

test('описания инструментов взяты из спеки, а не написаны отдельно', () => {
  const byTool = new Map(spec.methods.map((m) => [m.tool, m]));
  for (const t of manifest.tools) {
    const method = byTool.get(t.name);
    if (!method) continue; // справочные инструменты в спеке не описаны
    const source = method.summary ?? method.title ?? t.name;
    assert.ok(
      source.startsWith(t.description.slice(0, 40)),
      `описание ${t.name} разошлось со спекой`,
    );
  }
});

test('токен объявлен обязательным и секретным', () => {
  const token = manifest.user_config.token;
  assert.equal(token.required, true);
  assert.equal(token.sensitive, true, 'токен обязан быть помечен секретным');
});

test('запись про изменение не обещает того, чего сервер не делает', () => {
  // В манифесте нет DIRECT_ALLOW_WRITES, и это намеренно: бандл ставят одним
  // кликом, а включение записи должно оставаться осознанным действием.
  assert.equal(manifest.server.mcp_config.env.DIRECT_ALLOW_WRITES, undefined);
});
