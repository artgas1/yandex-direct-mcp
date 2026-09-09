import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiVersion, callDirect, DirectApiError } from './http.js';
import { resolveCabinet } from './identity.js';
import { countRows, parseTsv, runReport } from './reports.js';
import { unwrapItems } from './tools.js';

/**
 * Состав кабинета, собранный из ДВУХ источников сразу.
 *
 * Зачем отдельный инструмент, а не предупреждение в описании `campaigns.get`.
 *
 * Метод `campaigns.get` не отдаёт кампании Мастера кампаний — ни списком, ни по
 * явному `Ids`. Ответ при этом успешный и пустой: ошибки нет, признака нет,
 * отличить «такой кампании не существует» от «этот метод её не показывает»
 * нечем. Проверено на обеих версиях пути, v5 и v501: версия этого не лечит.
 *
 * Цена ошибки не теоретическая: кампания, невидимая для списка, может давать
 * основную долю показов кабинета. Инвентаризация по `campaigns.get` прошла бы
 * мимо главной кампании и выглядела бы полной.
 *
 * Предупреждение в описании тут помогает слабо: оно требует, чтобы читатель
 * помнил про него в момент вывода, а вывод делается по данным, которые выглядят
 * нормально. Поэтому источники склеиваются на стороне сервера, и каждая строка
 * несёт пометку, откуда она взялась. Не увидеть расхождение больше нельзя.
 */

type Registrar = Pick<McpServer, 'registerTool'>;

export const INVENTORY_TOOL = 'direct_inventory';

interface Row {
  Id: string;
  Name: string | null;
  Type: string | null;
  State: string | null;
  Impressions: number;
  Clicks: number;
  Cost: number;
  источник: 'список и отчёт' | 'только отчёт' | 'только список';
}

/** Даты по умолчанию — последние 30 суток, считая от переданной «сегодня». */
export function defaultWindow(today: Date): { from: string; to: string } {
  const day = 86_400_000;
  const iso = (d: Date): string => d.toISOString().slice(0, 10);
  // Верхняя граница — вчера: сегодняшний день в отчётах неполон.
  const to = new Date(today.getTime() - day);
  return { from: iso(new Date(to.getTime() - 29 * day)), to: iso(to) };
}

/**
 * Склейка двух источников. Вынесена отдельно от сети, чтобы её можно было
 * проверить тестом на данных, где расхождение заведомо есть.
 */
export function merge(
  listed: Array<Record<string, unknown>>,
  reported: Array<Record<string, unknown>>,
): { rows: Row[]; onlyReport: string[]; onlyList: string[] } {
  const byId = new Map<string, Row>();

  for (const c of listed) {
    const id = String(c.Id);
    byId.set(id, {
      Id: id,
      Name: (c.Name as string) ?? null,
      Type: (c.Type as string) ?? null,
      State: (c.State as string) ?? null,
      Impressions: 0,
      Clicks: 0,
      Cost: 0,
      источник: 'только список',
    });
  }

  for (const r of reported) {
    const id = String(r.CampaignId ?? '');
    if (!id || id === 'null') continue;
    const existing = byId.get(id);
    const stats = {
      Impressions: Number(r.Impressions ?? 0) || 0,
      Clicks: Number(r.Clicks ?? 0) || 0,
      Cost: Number(r.Cost ?? 0) || 0,
    };
    if (existing) {
      existing.Impressions += stats.Impressions;
      existing.Clicks += stats.Clicks;
      existing.Cost += stats.Cost;
      existing.источник = 'список и отчёт';
    } else {
      byId.set(id, {
        Id: id,
        Name: (r.CampaignName as string) ?? null,
        Type: (r.CampaignType as string) ?? null,
        State: null,
        ...stats,
        источник: 'только отчёт',
      });
    }
  }

  const rows = [...byId.values()].sort((a, b) => b.Impressions - a.Impressions);
  return {
    rows,
    onlyReport: rows.filter((r) => r.источник === 'только отчёт').map((r) => r.Id),
    onlyList: rows.filter((r) => r.источник === 'только список').map((r) => r.Id),
  };
}

export interface InventoryOptions {
  token: string;
  clientLogin?: string;
  maxOutputChars: number;
  /** Подменяется в тесте, чтобы окно по умолчанию не зависело от календаря. */
  now?: () => Date;
}

export function registerInventory(server: Registrar, options: InventoryOptions): void {
  server.registerTool(
    INVENTORY_TOOL,
    {
      title: 'Состав кабинета',
      description:
        'Полный состав кабинета: кампании из списка И кампании из отчёта, склеенные в одну ' +
        'таблицу с пометкой источника у каждой строки.\n\n' +
        'Зовите его вместо campaigns.get, когда нужен ответ на вопрос «что сейчас крутится». ' +
        'Метод campaigns.get не отдаёт кампании Мастера кампаний вовсе — ни списком, ни по ' +
        'явному Ids, и ответ при этом успешный и пустой, то есть отличить «нет такой» от ' +
        '«не показывается» нечем. При этом такая кампания может нести основную долю ' +
        'показов кабинета.\n\n' +
        'Строки с пометкой «только отчёт» — это как раз они: кампания откручивается, но ' +
        'списком не отдаётся, и управлять ею через API нельзя.',
      inputSchema: {
        DateFrom: z.string().optional().describe('YYYY-MM-DD; по умолчанию 30 суток назад'),
        DateTo: z.string().optional().describe('YYYY-MM-DD; по умолчанию вчера'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: Record<string, unknown>) => {
      const input = args ?? {};
      const window = defaultWindow((options.now ?? (() => new Date()))());
      const from = (input.DateFrom as string) ?? window.from;
      const to = (input.DateTo as string) ?? window.to;

      try {
        const listResponse = await callDirect({
          service: 'campaigns',
          method: 'get',
          params: { SelectionCriteria: {}, FieldNames: ['Id', 'Name', 'Type', 'State'] },
          token: options.token,
          clientLogin: options.clientLogin,
        });
        const listed = ((unwrapItems(
          (listResponse.result as Record<string, unknown> | null)?.result,
        ) as Record<string, unknown> | null)?.Campaigns ?? []) as Array<Record<string, unknown>>;

        const { tsv, units } = await runReport({
          params: {
            SelectionCriteria: { DateFrom: from, DateTo: to },
            FieldNames: ['CampaignId', 'CampaignName', 'CampaignType', 'Impressions', 'Clicks', 'Cost'],
            ReportName: `inventory_${from}_${to}`,
            ReportType: 'CAMPAIGN_PERFORMANCE_REPORT',
            DateRangeType: 'CUSTOM_DATE',
            Format: 'TSV',
            IncludeVAT: 'YES',
          },
          token: options.token,
          clientLogin: options.clientLogin,
        });
        const { rows: reported } = parseTsv(tsv, 5000);

        const { rows, onlyReport, onlyList } = merge(listed, reported as Array<Record<string, unknown>>);

        const notes: string[] = [];
        if (onlyReport.length) {
          notes.push(
            `${onlyReport.length} кампаний откручивались, но методом campaigns.get НЕ отдаются ` +
              `(${onlyReport.slice(0, 5).join(', ')}${onlyReport.length > 5 ? ', …' : ''}). ` +
              'Управлять ими через API нельзя — только в интерфейсе.',
          );
        }
        if (onlyList.length) {
          notes.push(`${onlyList.length} кампаний есть в списке, но за период не откручивались.`);
        }

        const cabinet = await resolveCabinet(options.token, options.clientLogin);
        const payload = {
          _мета: {
            кабинет: cabinet ? `${cabinet.login} (ClientId ${cabinet.clientId})` : 'не определён',
            версия_api: apiVersion(),
            период: `${from} … ${to}`,
            баллы: units,
            источники: `список ${listed.length}, отчёт ${countRows(tsv)} строк`,
            внимание: notes.length ? notes : undefined,
          },
          кампаний: rows.length,
          кампании: rows,
        };
        const body = JSON.stringify(payload);
        return {
          content: [
            {
              type: 'text' as const,
              text:
                body.length > options.maxOutputChars
                  ? `${body.slice(0, options.maxOutputChars)}…`
                  : JSON.stringify(payload, null, 2),
            },
          ],
        };
      } catch (e) {
        const message =
          e instanceof DirectApiError
            ? `Директ отказал: код ${e.code}. ${e.detail}`
            : `Не собрал состав кабинета: ${e instanceof Error ? e.message : String(e)}`;
        return { content: [{ type: 'text' as const, text: message }], isError: true };
      }
    },
  );
}
