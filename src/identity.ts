import { callDirect } from './http.js';

/**
 * Какой кабинет отвечает на самом деле.
 *
 * Зачем спрашивать, а не верить настройке. Заголовок `Client-Login` переключает
 * кабинет по-настоящему: под одним токеном с заголовком и без него отвечают
 * РАЗНЫЕ аккаунты — разные Login и ClientId, разные кампании, разная квота баллов.
 *
 * Отсюда развилка по громкости отказа:
 *   несуществующий логин   → код 8800 «Объект не найден» — видно сразу;
 *   существующий, но НЕ ТОТ → тишина. Данные приходят полные и правильные,
 *                             просто из другого кабинета.
 *
 * Второй случай не отличим от первого по виду ответа, поэтому сервер называет
 * фактический кабинет в каждом ответе. Спрашивается он один раз за запуск и
 * кешируется: `clients.get` стоит 10 баллов, платить их на каждом вызове незачем.
 */

export interface Cabinet {
  login: string;
  clientId: string;
}

let cached: Promise<Cabinet | null> | null = null;

export function resolveCabinet(token: string, clientLogin?: string): Promise<Cabinet | null> {
  if (cached) return cached;
  cached = (async () => {
    try {
      const res = await callDirect({
        service: 'clients',
        method: 'get',
        params: { FieldNames: ['Login', 'ClientId'] },
        token,
        clientLogin,
        retries: 0,
        timeoutMs: 20_000,
      });
      const body = (res.result as Record<string, unknown> | null)?.result as
        | Record<string, unknown>
        | undefined;
      const first = (body?.Clients as Array<Record<string, unknown>> | undefined)?.[0];
      if (!first) return null;
      return { login: String(first.Login), clientId: String(first.ClientId) };
    } catch {
      // Определить кабинет не удалось — это не повод ронять вызов, ради
      // которого сервер и запущен. Скажем «не определён» и пойдём дальше.
      return null;
    }
  })();
  return cached;
}

/** Для тестов: сбросить кеш между случаями. */
export function resetCabinetCache(): void {
  cached = null;
}
