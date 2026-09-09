#!/usr/bin/env node
/**
 * Таблица покрытия для README — считается из спеки, а не пишется руками.
 *
 * Числа в прозе тухнут молча: в этом репозитории уже расходились счётчики типов
 * (604/235 против 609/240), кратность веса поверхности и число проверок. Таблица
 * покрытия — тот же класс: спека пересобирается, README остаётся прежним, и
 * неправда выглядит ровно как правда.
 *
 * Поэтому здесь два выхода из одного источника: `print` печатает готовый
 * markdown, а `rows()` зовёт тест, который сверяет README со спекой.
 *
 * Запуск: node tools/coverage.mjs   (через npm run coverage)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Группы — единственное здесь, что выбрано человеком: у API 30 служб, и
 * таблица на 30 строк не читается. Состав групп проверяется на полноту ниже,
 * поэтому новая служба в спеке роняет сборку, а не выпадает из таблицы молча.
 */
export const GROUPS = [
  [
    'Кампании и объявления',
    [
      'campaigns',
      'adgroups',
      'ads',
      'adextensions',
      'adimages',
      'advideos',
      'creatives',
      'sitelinks',
      'vcards',
    ],
  ],
  [
    'Таргетинг',
    [
      'keywords',
      'keywordsresearch',
      'negativekeywordsharedsets',
      'retargetinglists',
      'audiencetargets',
      'smartadtargets',
      'dynamictextadtargets',
      'dynamicfeedadtargets',
      'feeds',
    ],
  ],
  ['Ставки и стратегии', ['bids', 'keywordbids', 'bidmodifiers', 'strategies']],
  ['Отчёты и справочники', ['reports', 'dictionaries', 'changes', 'businesses', 'leads', 'turbopages']],
  ['Клиенты и агентства', ['clients', 'agencyclients']],
];

export async function rows() {
  const spec = JSON.parse(readFileSync(join(root, 'spec/direct-api.json'), 'utf8'));
  const { CORE_TOOLS } = await import(join(root, 'build/profiles.js'));
  const core = new Set(CORE_TOOLS);

  const services = new Set(spec.methods.map((m) => m.service));
  const grouped = new Set(GROUPS.flatMap(([, s]) => s));
  const ungrouped = [...services].filter((s) => !grouped.has(s));
  const phantom = [...grouped].filter((s) => !services.has(s));
  if (ungrouped.length || phantom.length) {
    throw new Error(
      `группировка разошлась со спекой — вне групп: [${ungrouped}], несуществующие: [${phantom}]`,
    );
  }

  const out = GROUPS.map(([label, svcs]) => {
    const methods = spec.methods.filter((m) => svcs.includes(m.service));
    const kept = methods.filter((m) => core.has(m.tool));
    return {
      label,
      services: svcs.length,
      methods: methods.length,
      core: kept.length,
      examples: (kept.length ? kept : methods.slice(0, 2)).slice(0, 2).map((m) => m.tool),
    };
  });

  return {
    groups: out,
    totalServices: services.size,
    totalMethods: spec.methods.length,
    totalCore: CORE_TOOLS.length,
  };
}

export function markdown(r) {
  const lines = [
    '| что покрыто | служб | методов | из них в `core` | примеры инструментов |',
    '| --- | ---: | ---: | ---: | --- |',
  ];
  for (const g of r.groups) {
    lines.push(
      `| ${g.label} | ${g.services} | ${g.methods} | ${g.core || '—'} | ` +
        `${g.examples.map((e) => `\`${e}\``).join(', ')} |`,
    );
  }
  lines.push(
    `| **всего** | **${r.totalServices}** | **${r.totalMethods}** | **${r.totalCore}** | ` +
      'плюс четыре служебных: `direct_catalog`, `direct_fields`, `direct_schema`, `direct_inventory` |',
  );
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(markdown(await rows()));
}
