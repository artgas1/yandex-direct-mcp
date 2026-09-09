#!/usr/bin/env node
/**
 * Порождает справочники скилла из спеки.
 *
 * Руками их писать нельзя по той же причине, по которой руками не пишутся
 * инструменты: список из головы расходится с API молча. Четыре чужих скилла
 * для Директа, которые я смотрел, перечисляют методы вручную — и у каждого
 * список неполон, но узнать это можно только сверкой с API.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const spec = JSON.parse(readFileSync(fileURLToPath(new URL('../spec/direct-api.json', import.meta.url)), 'utf8'));
const OUT = fileURLToPath(new URL('../skills/yandex-direct/references/', import.meta.url));

const KIND = { read: 'чтение', write: 'изменение', destructive: 'удаление' };

function methodsDoc() {
  const byService = {};
  for (const m of spec.methods) (byService[m.service] ??= []).push(m);

  const lines = [
    '# Методы API Директа',
    '',
    `Порождено из схемы. Служб ${Object.keys(byService).length}, методов ${spec.methods.length} ` +
      `(читающих ${spec.kinds.read}, меняющих ${spec.kinds.write}, удаляющих ${spec.kinds.destructive}).`,
    '',
    'Вызов: `yandex-direct-mcp call <служба>.<метод> --Параметр значение`.',
    'Параметры конкретного метода: `yandex-direct-mcp describe <служба>.<метод>`.',
    '',
    '⚠️ Меняющие и удаляющие методы требуют `DIRECT_ALLOW_WRITES=1`.',
    '',
  ];

  for (const service of Object.keys(byService).sort()) {
    const methods = byService[service].slice().sort((a, b) => a.operation.localeCompare(b.operation));
    lines.push(`## ${service}`, '');
    lines.push('| метод | характер | что делает |', '|---|---|---|');
    for (const m of methods) {
      const summary = (m.summary ?? '').replace(/\|/g, '\\|').slice(0, 150);
      lines.push(`| \`${m.operation}\` | ${KIND[m.kind]} | ${summary} |`);
    }
    lines.push('');

    // Обязательные параметры перечисляем: без них вызов не соберётся, а
    // describe на каждый метод — лишний ход.
    const required = methods
      .map((m) => {
        const req = (m.request ?? []).filter((f) => f.required).map((f) => f.name);
        return req.length ? `\`${m.operation}\`: ${req.join(', ')}` : null;
      })
      .filter(Boolean);
    if (required.length) {
      lines.push(`Обязательные параметры — ${required.join('; ')}.`, '');
    }
  }

  lines.push('## Оговорки', '');
  for (const c of spec.caveats) lines.push(`- ${c}`, '');
  return lines.join('\n');
}

function reportsDoc() {
  const pick = (name) => spec.enums[name] ?? [];
  const lines = [
    '# Отчёты Директа',
    '',
    'Служба `reports` — основной инструмент счёта и единственная с асинхронным протоколом.',
    '',
    '```bash',
    'yandex-direct-mcp call reports.get \\',
    '  --ReportType CAMPAIGN_PERFORMANCE_REPORT \\',
    '  --FieldNames CampaignId --FieldNames CampaignName \\',
    '  --FieldNames Impressions --FieldNames Clicks --FieldNames Cost \\',
    '  --DateRangeType LAST_30_DAYS',
    '```',
    '',
    '## Как он себя ведёт',
    '',
    '- Ответ приходит не сразу: `201` поставлен в очередь, `202` считается, `200` готов.',
    '  Повтор идёт с тем же `ReportName` — имя и есть ключ задачи. Команда ждёт сама.',
    '- Суммы запрашиваются в единицах валюты счёта принудительно. По умолчанию API отдаёт их',
    '  умноженными на миллион: `Cost 1234500000` и `1234.50` — одна и та же сумма.',
    '- Пропуск обозначается `--`, а не нулём и не пустой ячейкой.',
    '- Синхронный вызов на большом окне отдаёт `504`, а не данные.',
    '',
    '## Типы отчётов',
    '',
    ...pick('ReportTypeEnum').map((v) => `- \`${v}\``),
    '',
    '## Периоды',
    '',
    ...pick('DateRangeTypeEnum').map((v) => `- \`${v}\``),
    '',
    '## Ограничения, на которых спотыкаются',
    '',
    '- `AttributionModels` допустимы ТОЛЬКО вместе с `Goals`.',
    '- `Filter` — всегда массив, даже для одного условия.',
    '- `ImpressionShare` запрещён в `CUSTOM_REPORT`; в `CAMPAIGN_PERFORMANCE_REPORT`',
    '  разрешён, но у поисковых кампаний приезжает `--`.',
    '- Колонки целей приезжают с суффиксами: `Conversions_<goalId>_<attribution>`.',
    '- Полный список полей: https://yandex.ru/dev/direct/doc/ru/reports/fields-list',
    '',
    '## Зачем отчёт даже там, где хватило бы списка',
    '',
    'Кампании Мастера кампаний не отдаются методом `campaigns.get` вовсе — ни списком,',
    'ни по явному `Ids`; ответ пустой и без ошибки. При этом откручиваться они могут',
    'наравне с остальными и давать основную долю показов. Отчёт видит всё, что',
    'откручивалось, поэтому состав кабинета определяется отсюда.',
    '',
  ];
  return lines.join('\n');
}

await mkdir(OUT, { recursive: true });
await writeFile(new URL('methods.md', `file://${OUT}`), methodsDoc());
await writeFile(new URL('reports.md', `file://${OUT}`), reportsDoc());
console.error(`справочники собраны: methods.md, reports.md (методов ${spec.methods.length})`);
