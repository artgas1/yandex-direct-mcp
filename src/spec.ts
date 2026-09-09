import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Характер операции. Определяет и аннотации, и право вызова. */
export type Kind = 'read' | 'write' | 'destructive';

export interface Field {
  name: string;
  required: boolean;
  /**
   * Массив в смысле `maxOccurs="unbounded"` — и это НЕ то же самое, что
   * «поле-список». Директ выражает списки двумя разными способами, и форма
   * значения у них разная в обе стороны:
   *
   *   maxOccurs="unbounded"  → голый массив:      "RegionIds": [225, 977]
   *   тип general:ArrayOf*   → объект с Items:    "RestrictedRegionIds": {"Items": [225]}
   *
   * Проверено на живых данных на одной и той же группе объявлений.
   * Различие берётся отсюда, из графа типов, и никогда не угадывается по виду
   * значения: догадка по виду ломает круг «прочитал — поправил — записал»
   * ровно там, где сейчас всё работает.
   */
  array: boolean;
  type: string;
  /** Смысл, который из типа не выводится: деньги и идентификаторы оба `long`. */
  semantic?: 'money' | 'id';
  /** Поля анонимного вложенного типа. */
  fields?: Field[];
}

/** Тип-обёртка вида general:ArrayOfLong — значение приезжает как {"Items": [...]}. */
export function isWrapperArray(field: Field): boolean {
  return /^ArrayOf/.test(field.type);
}

export interface Method {
  service: string;
  operation: string;
  tool: string;
  kind: Kind;
  docUrl: string;
  title: string | null;
  summary: string | null;
  summarySource?: 'docs' | 'synthesized';
  request: Field[] | null;
  response: Field[] | string | null;
  documented?: boolean;
  note?: string;
}

export interface TypeDef {
  name: string;
  fields: Field[];
  inheritedFrom?: string;
}

export interface Spec {
  source: Record<string, string>;
  counts: { services: number; methods: number; types: number; enums: number; undocumented: number };
  kinds: Record<Kind, number>;
  caveats: string[];
  methods: Method[];
  types: Record<string, TypeDef>;
  enums: Record<string, string[]>;
  problems: string[];
}

/**
 * Спека лежит рядом со сборкой и является единственным источником состава API.
 * Ни один метод в коде не описан руками: появится новая служба — она приедет
 * сюда прогоном tools/parse-spec.mjs, а тест на дрейф покраснеет до того, как
 * расхождение кого-нибудь укусит.
 */
export function loadSpec(): Spec {
  const path = fileURLToPath(new URL('../spec/direct-api.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as Spec;
}

/**
 * Поля-идентификаторы. В WSDL они объявлены как `long`, и это ровно те места,
 * где число не помещается в JavaScript: замер дал Id объявления из
 * девятнадцати цифр. Такие поля сервер держит строками — и на выходе, и на
 * входе (API принимает строку наравне с числом, проверено).
 */
export function isIdField(field: Field): boolean {
  return field.type === 'long';
}
