#!/usr/bin/env node
/**
 * Сборка MCPB-бандла — упаковки сервера для установки одним файлом.
 *
 * Зачем это здесь, а не руками. Бандл — самостоятельная копия сервера: манифест
 * с именем, версией и списком инструментов плюс сам код с зависимостями. Копия,
 * которую правят руками, расходится с оригиналом молча: версия в манифесте
 * отстаёт от package.json, список инструментов — от спеки, и заметить это можно
 * только на чужой машине. Поэтому манифест ПОРОЖДАЕТСЯ из тех же источников,
 * из которых работает сам сервер.
 *
 * Один бандл открывает два канала: установку в Claude Desktop и Smithery,
 * которой для stdio-сервера нужен ровно он же.
 *
 * Запуск: node tools/build-mcpb.mjs [--pack]
 *   без --pack — только собрать staging-каталог и манифест (быстро, для CI)
 *   с   --pack — дополнительно позвать `mcpb pack` и получить .mcpb-файл
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const stage = join(root, '.mcpb-build');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const spec = JSON.parse(readFileSync(join(root, 'spec/direct-api.json'), 'utf8'));

// Состав профиля по умолчанию берём из самого профиля, а не из копии:
// разойтись им тогда физически негде.
const { CORE_TOOLS } = await import(join(root, 'build/profiles.js'));
const { CATALOG_TOOL } = await import(join(root, 'build/catalog.js'));
const byTool = new Map(spec.methods.map((m) => [m.tool, m]));

const missing = CORE_TOOLS.filter((t) => !byTool.has(t));
if (missing.length) {
  console.error(`В спеке нет инструментов профиля core: ${missing.join(', ')}`);
  process.exit(1);
}

const REPO = 'https://github.com/artgas1/yandex-direct-mcp';

const tools = [
  ...CORE_TOOLS.map((t) => ({
    name: t,
    description: (byTool.get(t).summary ?? byTool.get(t).title ?? t).slice(0, 180),
  })),
  { name: 'direct_inventory', description: 'Состав кабинета из списка кампаний и отчёта сразу' },
  { name: CATALOG_TOOL, description: 'Какие ещё методы есть и как их включить' },
  { name: 'direct_fields', description: 'Допустимые значения перечислений' },
  { name: 'direct_schema', description: 'Точный состав типа Директа' },
];

const manifest = {
  manifest_version: '0.3',
  name: pkg.name,
  display_name: 'Яндекс Директ',
  version: pkg.version,
  description: pkg.description,
  long_description:
    `Полное покрытие API Яндекс Директа v5: ${spec.counts.methods} методов из ` +
    `${spec.counts.services} служб, порождённых из машиночитаемой схемы. ` +
    'По умолчанию объявляется узкий набор для чтения и счёта, изменение выключено. ' +
    'Суммы приводятся к валюте счёта, длинные идентификаторы не портятся разбором, ' +
    'отказ определяется телом ответа, а не кодом, отчёты дожидаются готовности.',
  author: { name: pkg.author },
  homepage: REPO,
  documentation: `${REPO}#readme`,
  support: `${REPO}/issues`,
  license: pkg.license,
  keywords: pkg.keywords,
  server: {
    type: 'node',
    entry_point: 'build/index.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/build/index.js'],
      env: { YANDEX_DIRECT_TOKEN: '${user_config.token}' },
    },
  },
  tools,
  user_config: {
    token: {
      type: 'string',
      title: 'OAuth-токен Яндекса',
      description: 'Токен со scope direct:api — https://oauth.yandex.ru/',
      sensitive: true,
      required: true,
    },
  },
  compatibility: { runtimes: { node: '>=20' } },
};

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
cpSync(join(root, 'build'), join(stage, 'build'), { recursive: true });
cpSync(join(root, 'spec'), join(stage, 'spec'), { recursive: true });
for (const f of ['README.md', 'LICENSE']) cpSync(join(root, f), join(stage, f));

writeFileSync(
  join(stage, 'package.json'),
  `${JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module', dependencies: pkg.dependencies }, null, 2)}\n`,
);
cpSync(join(root, 'package-lock.json'), join(stage, 'package-lock.json'));

/**
 * Зависимости ставим настоящей установкой, а не переносом каталогов.
 *
 * Первая редакция копировала объявленные зависимости и пару угаданных
 * транзитивных. Бандл собирался, весил мегабайт и выглядел исправным — а при
 * запуске падал на `zod-to-json-schema`, которого никто не объявлял напрямую:
 * его тянет SDK. Проверкой сборки это не ловится вовсе, только запуском.
 */
console.error(`манифест собран: ${tools.length} инструментов, версия ${manifest.version}`);

if (process.argv.includes('--pack')) {
  // Установка идёт только при упаковке: без неё проверка манифеста остаётся
  // быстрой и годится для CI, а бандл всё равно собирается с полным деревом.
  execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--silent'], {
    cwd: stage,
    stdio: 'inherit',
  });
  execFileSync('npx', ['-y', '@anthropic-ai/mcpb', 'pack', stage, join(root, `${pkg.name}-${pkg.version}.mcpb`)], {
    stdio: 'inherit',
  });
  const out = join(root, `${pkg.name}-${pkg.version}.mcpb`);
  console.error(`бандл: ${out} (${(statSync(out).size / 1024).toFixed(0)} КБ)`);
}
