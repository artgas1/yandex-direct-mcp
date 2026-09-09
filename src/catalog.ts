import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { KIND_LABEL } from './annotations.js';
import type { Method, Spec } from './spec.js';

/**
 * Инструмент, который рассказывает про самого себя.
 *
 * Зачем он нужен. Сервер объявляет по умолчанию девять инструментов из ста
 * тринадцати — и это невидимо для человека. Модель узнаёт из `instructions`,
 * а человек, поставивший пакет одной строкой, не узнаёт ниоткуда, кроме README:
 * в интерфейс клиента `instructions` не показываются, а стартовую строку в
 * stderr в обычной работе никто не открывает.
 *
 * Отсюда правило: если сервер что-то СКРЫЛ, он обязан уметь сказать, что
 * именно и как это включить. Спросить словами дешевле, чем идти читать
 * документацию, и происходит ровно в тот момент, когда нужно.
 *
 * Почему инструмент, а не строка в `instructions`: те резидентны на каждом
 * ходу, и список из ста тринадцати имён стоил бы там сотни токенов постоянно.
 * Схема этого инструмента пустая, а вес ответа платится только при вызове.
 */

export const CATALOG_TOOL = 'direct_catalog';

/** Ровно та часть McpServer, которой пользуемся. */
type Registrar = Pick<McpServer, 'registerTool'>;

export interface CatalogOptions {
  label: string;
  include: (method: Method) => boolean;
  allowWrites: boolean;
  widenHint?: string;
}

function group(methods: Method[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of methods) (out[m.service] ??= []).push(`${m.operation} (${KIND_LABEL[m.kind]})`);
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

export function buildCatalog(spec: Spec, options: CatalogOptions): Record<string, unknown> {
  const shown = spec.methods.filter((m) => options.include(m));
  const hidden = spec.methods.filter((m) => !options.include(m));

  return {
    объявлено: shown.length,
    всего_в_api: spec.methods.length,
    отбор: options.label,
    запись: options.allowWrites ? 'РАЗРЕШЕНА' : 'выключена — меняющие инструменты не объявлены',
    объявленные: group(shown),
    скрытые: group(hidden),
    как_расширить:
      options.widenHint ??
      'Всё уже объявлено. Управление сущностями требует DIRECT_ALLOW_WRITES=1.',
    оговорки: spec.caveats,
  };
}

export function registerCatalog(server: Registrar, spec: Spec, options: CatalogOptions): void {
  server.registerTool(
    CATALOG_TOOL,
    {
      title: 'Что ещё умеет сервер',
      description:
        'Перечисляет ВСЕ методы API Директа и показывает, какие из них объявлены сейчас, а какие ' +
        'скрыты и как их включить. Зовите, когда нужного инструмента не видно среди доступных: ' +
        'скорее всего он существует, но не объявлен ради экономии контекста.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify(buildCatalog(spec, options), null, 2) }],
    }),
  );
}

/** Пустая схема, объявленная явно. */
export const NO_PARAMS = z.object({}).strict();
