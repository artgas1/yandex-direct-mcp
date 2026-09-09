import type { Field, Spec, TypeDef } from './spec.js';

/**
 * Приведение сумм из микро-единиц.
 *
 * Почему это делает сервер, а не потребитель. В json v5 деньги приходят
 * умноженными на миллион ВСЕГДА: замер дал `DailyBudget.Amount`
 * = 1000000000, то есть 1000 единиц валюты счёта. Заголовок `returnMoneyInMicros`, который
 * выключает микро-единицы в отчётах, на обычные службы не действует — проверено
 * на campaigns, значение не изменилось.
 *
 * Опасна тут не сама единица, а её вид. 1000000000 — правдоподобное число:
 * его можно сложить, поделить, построить по нему график и сделать вывод.
 * Ошибка ровно в миллион раз не выглядит ошибкой ни на одном шаге.
 *
 * Выбранное решение — пересчитывать, но не молча. Значение приводится к валюте
 * счёта, а в ответе перечисляется, КАКИЕ поля были пересчитаны. Это важнее,
 * чем кажется: если разметка когда-нибудь ошибётся и деньгами будет названо не
 * то поле, ошибку станет видно в самом ответе, а не через месяц в отчёте.
 */

export const MICRO = 1_000_000;

/** Имена денежных полей берём из спеки, а не из второго списка в коде. */
export function moneyFields(spec: Spec): Set<string> {
  const names = new Set<string>();

  const walk = (fields: Field[] | null | undefined): void => {
    for (const f of fields ?? []) {
      if (f.semantic === 'money') names.add(f.name);
      walk(f.fields);
    }
  };

  for (const t of Object.values(spec.types) as TypeDef[]) walk(t.fields);
  for (const m of spec.methods) walk(m.request);

  return names;
}

export interface Normalized {
  value: unknown;
  /** Имена полей, значения которых пересчитаны. Пусто — ничего не тронуто. */
  converted: string[];
}

/**
 * Обходит дерево ответа и приводит денежные поля к валюте счёта.
 * Значение, пришедшее строкой (длинное целое), не трогаем: строкой приезжают
 * идентификаторы, а суммы такого размера означали бы не деньги, а ошибку.
 */
export function normalizeMoney(node: unknown, money: Set<string>): Normalized {
  const converted = new Set<string>();

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;

    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (money.has(key) && typeof raw === 'number') {
        out[key] = raw / MICRO;
        converted.add(key);
      } else if (money.has(key) && Array.isArray(raw) && raw.every((x) => typeof x === 'number')) {
        // CompetitorsBids приезжает массивом ставок.
        out[key] = (raw as number[]).map((x) => x / MICRO);
        converted.add(key);
      } else {
        out[key] = walk(raw);
      }
    }
    return out;
  };

  return { value: walk(node), converted: [...converted].sort() };
}

/**
 * Обратное приведение — для того, что уходит в API. Человек и модель называют
 * ставку как «30» рублей, а Директ ждёт 30000000. Без этого правка ставки
 * промахивается на шесть порядков в ту же сторону, что и чтение, только теперь
 * это не отчёт, а деньги.
 */
export function toMicro(node: unknown, money: Set<string>): unknown {
  if (Array.isArray(node)) return node.map((x) => toMicro(x, money));
  if (!node || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(node as Record<string, unknown>)) {
    if (money.has(key) && typeof raw === 'number') {
      out[key] = Math.round(raw * MICRO);
    } else if (money.has(key) && Array.isArray(raw) && raw.every((x) => typeof x === 'number')) {
      out[key] = (raw as number[]).map((x) => Math.round(x * MICRO));
    } else {
      out[key] = toMicro(raw, money);
    }
  }
  return out;
}
