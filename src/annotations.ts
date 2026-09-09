import type { Kind, Method } from './spec.js';

/**
 * Аннотации инструмента. Клиенты (Claude Desktop, Cursor, Windsurf) читают их,
 * чтобы решить, спрашивать ли у человека подтверждение: читающее выполняется
 * само, меняющее — с вопросом.
 *
 * Для Директа эта разметка весит больше обычного. Подтверждающего шага у самого
 * API нет вовсе: `archive`, `suspend` и `delete` срабатывают в момент вызова,
 * отмены нет, а на другом конце деньги и открученные показы. Единственное место,
 * где между моделью и остановленной кампанией может встать человек, — вот эта
 * разметка и выключенная по умолчанию запись.
 */
export interface Annotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * Идемпотентность здесь понимается буквально: повтор не меняет результат.
 * `add` не идемпотентна — повтор создаёт второй объект. `suspend` идемпотентна:
 * остановленное второй остановкой не портится.
 */
const NON_IDEMPOTENT = new Set(['add', 'addPassportOrganization', 'addPassportOrganizationMember']);

export function annotate(method: Method): Annotations {
  const read = method.kind === 'read';
  return {
    readOnlyHint: read,
    destructiveHint: method.kind === 'destructive',
    idempotentHint: read || !NON_IDEMPOTENT.has(method.operation),
    // Ответ приходит из внешней системы и содержит данные, введённые людьми:
    // названия кампаний, тексты объявлений, поисковые запросы. Это данные,
    // а не указания.
    openWorldHint: true,
  };
}

export function isWrite(method: Method): boolean {
  return method.kind !== 'read';
}

export const KIND_LABEL: Record<Kind, string> = {
  read: 'чтение',
  write: 'изменение',
  destructive: 'удаление',
};
