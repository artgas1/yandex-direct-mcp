import { isWrite } from './annotations.js';
import type { Method } from './spec.js';

/**
 * Поверхность сервера — то, за что клиент платит на КАЖДОМ ходу: описания всех
 * объявленных инструментов лежат в контексте модели постоянно, вызываешь ты их
 * или нет. При 113 методах объявить всё — значит потратить десятки тысяч токенов
 * ещё до первого вопроса.
 *
 * Отсюда правило: по умолчанию объявляется не всё, что умеет API, а то, чем
 * пользуются. Остальное включается явно и осознанно. Цифры поверхности по
 * профилям измерены и приведены в README — здесь их не дублируем, потому что
 * прозой они устаревают молча.
 */
export type ProfileName = 'core' | 'read' | 'all';

export const PROFILE_NAMES: readonly ProfileName[] = ['core', 'read', 'all'];

export const DEFAULT_PROFILE: ProfileName = 'core';

/**
 * Состав `core` — набор под задачу «посмотреть, что крутится, и посчитать».
 *
 * Первым стоит `reports`, и это не алфавит. Метод `campaigns.get` НЕ отдаёт
 * кампании Мастера кампаний: ни списком, ни по явному Ids — ответ пустой, без
 * ошибки. На кабинете, где такая кампания есть, она может нести основную долю
 * показов, то есть инвентаризация по `campaigns.get` пропустила бы главную
 * кампанию и не подала бы признака.
 * Состав кабинета определяется отчётом, и отчёт обязан быть под рукой всегда.
 *
 * Управление сущностями в `core` не входит: это другая задача, она случается
 * на порядок реже, и её цена — не десятки тысяч токенов в каждом ходу.
 */
export const CORE_TOOLS: readonly string[] = [
  'direct_reports_get',
  'direct_campaigns_get',
  'direct_adgroups_get',
  'direct_ads_get',
  'direct_keywords_get',
  'direct_keywordbids_get',
  'direct_bidmodifiers_get',
  'direct_clients_get',
  'direct_dictionaries_get',
];

export function isProfileName(value: string): value is ProfileName {
  return (PROFILE_NAMES as readonly string[]).includes(value);
}

export interface SurfaceOptions {
  /** Значение DIRECT_PROFILE. Пусто — берём умолчание. */
  profile?: string;
  /** Значение DIRECT_TOOLS: явный список побеждает профиль. */
  tools?: string;
  /** Разрешено ли изменение. Меняющие инструменты не объявляются, пока нет. */
  allowWrites: boolean;
}

export interface Surface {
  include: (method: Method) => boolean;
  /** Человекочитаемый источник отбора — уходит в stderr при старте. */
  label: string;
  /** Подсказка «как расширить», если сейчас видно не всё. */
  widenHint?: string;
}

/**
 * Меняющие данные инструменты не объявляются, пока запись выключена.
 *
 * Объявлять их и отказывать на вызове — худший из вариантов: контекст за них
 * платится полностью, а позвать всё равно нельзя. У Директа таких 80 из 113,
 * то есть больше двух третей поверхности были бы чистой стоимостью без единого
 * возможного применения.
 */
function writable(method: Method, allowWrites: boolean): boolean {
  return allowWrites || !isWrite(method);
}

export function resolveSurface(options: SurfaceOptions): Surface {
  const explicit = (options.tools ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (explicit.length) {
    return {
      include: (m) =>
        writable(m, options.allowWrites) &&
        explicit.some((f) => f === m.service || m.tool === f || m.tool.startsWith(`${f}_`)),
      label: `DIRECT_TOOLS=${explicit.join(',')}`,
    };
  }

  const raw = (options.profile ?? '').trim();
  if (raw && !isProfileName(raw)) {
    throw new Error(`DIRECT_PROFILE=${raw} — неизвестный профиль. Допустимы: ${PROFILE_NAMES.join(', ')}.`);
  }
  const profile: ProfileName = isProfileName(raw) ? raw : DEFAULT_PROFILE;

  if (profile === 'core') {
    return {
      include: (m) => writable(m, options.allowWrites) && CORE_TOOLS.includes(m.tool),
      label: 'DIRECT_PROFILE=core',
      widenHint:
        'Остальные читающие инструменты: DIRECT_PROFILE=read. Управление кампаниями, ' +
        'группами, объявлениями и ставками: DIRECT_PROFILE=all и DIRECT_ALLOW_WRITES=1.',
    };
  }

  if (profile === 'read') {
    return {
      include: (m) => !isWrite(m),
      label: 'DIRECT_PROFILE=read',
      widenHint: 'Меняющие данные инструменты: DIRECT_PROFILE=all и DIRECT_ALLOW_WRITES=1.',
    };
  }

  return {
    include: (m) => writable(m, options.allowWrites),
    label: 'DIRECT_PROFILE=all',
    widenHint: options.allowWrites
      ? undefined
      : 'Меняющие данные инструменты скрыты, пока не задан DIRECT_ALLOW_WRITES=1.',
  };
}
