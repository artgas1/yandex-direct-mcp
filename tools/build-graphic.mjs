#!/usr/bin/env node
/**
 * Графика поверхности: все методы API, из которых профиль по умолчанию
 * оставляет девять.
 *
 * chart-brief:
 *   вопрос      Сколько стоит подключение сервера — то есть сколько описаний
 *               лежит в контексте модели на каждом ходу, вызываешь ты их или
 *               нет.
 *   форма       Не график чисел, а список как масса: работа данных здесь —
 *               показать объём скрытого. Вычеркнутое читается раньше, чем
 *               читатель дойдёт до цифры; столбиковая диаграмма сказала бы
 *               «13 против 117» абстрактно, список говорит то же предметно.
 *               Числом подписан только итог — вес манифеста в байтах.
 *   различие    Зачёркиванием и насыщенностью, не одним цветом. Оставленные
 *               девять вдобавок лежат на подложке — три независимых признака.
 *   палитра     Замерена, не подобрана на глаз (WCAG к бумаге #eceef0):
 *                 #16191d  оставленное      15,16:1  AA
 *                 #4c545e  подзаголовок      7,55:1  AA
 *                 #c23327  акцент            4,76:1  AA
 *                 #5c646f  вычеркнутое       5,15:1  AA
 *               ⚠️ Соседний yandex-metrika-mcp красит вычеркнутое в #98a1ab —
 *               это 2,25:1, AA не проходит. Здесь взят более тёмный тон:
 *               порядок читаемости держат зачёркивание и жирность, а не
 *               выцветание до нечитаемости.
 *               Валидатор категориальных палитр здесь неприменим по его же
 *               оговорке: это текстовые чернила, а не серии. Для одиночных
 *               текстовых цветов он отсылает к контрасту WCAG — он и посчитан.
 *   движение    Зачёркивание проигрывается один раз (~3,4 с) и остаётся: у
 *               картинки нет органов управления, а WCAG 2.2 SC 2.2.2 требует
 *               их для движения дольше пяти секунд. Плюс guard на
 *               prefers-reduced-motion.
 *   подложка    Своя, а не прозрачная: медиазапросы внутри <img>-SVG работают
 *               не везде, а подложка везде — картинка держит обе темы GitHub.
 *   источник    spec/direct-api.json, профиль из build/profiles.js и замер
 *               tools/measure-surface.mjs. Ни имена, ни числа не переписаны в
 *               макет: разойтись с реальностью им негде.
 *   не делаем   Наведения нет — это <img> в README, где его не бывает. Все
 *               числа продублированы текстом рядом с картинкой, поэтому
 *               картинка не является единственным носителем факта.
 *
 * Запуск: node tools/build-graphic.mjs   (через npm run graphic)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const spec = JSON.parse(readFileSync(join(root, 'spec/direct-api.json'), 'utf8'));
const { CORE_TOOLS } = await import(join(root, 'build/profiles.js'));

const core = new Set(CORE_TOOLS);
const kept = spec.methods.map((m) => m.tool).filter((t) => core.has(t));
const cut = spec.methods.map((m) => m.tool).filter((t) => !core.has(t));
const names = [...kept, ...cut];

/**
 * Вес манифеста берём тем же замером, что печатает `npm run surface`, а не
 * переписываем числа руками: иначе картинка и README разойдутся при первой же
 * правке спеки, и разойдутся молча.
 */
function weights() {
  const out = execFileSync(process.execPath, [join(root, 'tools/measure-surface.mjs')], {
    encoding: 'utf8',
  });
  const pick = (label) => {
    const row = out.split('\n').find((l) => l.startsWith(label));
    if (!row) throw new Error(`строка «${label}» не найдена в замере поверхности`);
    const nums = row.replace(label, '').match(/\d+/g);
    if (!nums || nums.length < 3) throw new Error(`не разобрал числа строки «${label}»`);
    return { tools: Number(nums[0]), bytes: Number(nums[1]) };
  };
  return { core: pick('core (умолчание)'), all: pick('all, запись разрешена') };
}

const W = weights();

// Общий префикс есть у всех 113 имён и не различает ни одно — в макете он
// съедал бы четверть строки. Убираем и говорим об этом подписью.
const PREFIX = 'direct_';
const short = (name) => (name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name);

// Служебных инструментов в спеке API нет: это каталог, поля, схема и сводка.
// Без этой оговорки картинка (9) читалась бы как опровержение README (13).
const HELPERS = W.core.tools - kept.length;

const C = {
  paper: '#eceef0',
  panel: '#e3e6ea',
  panelEdge: '#d2d7dd',
  ink: '#16191d',
  lede: '#4c545e',
  cut: '#5c646f',
  accent: '#c23327',
  keepBox: '#cfdcea',
  yandex: '#fc3f1d',
};

const COLS = 4;
const COL_X = [48, 319.5, 591, 862.5];
const ADVANCE = 5.4; // 9px моноширинный, 0,6em на кегль
const PITCH = 13.4;
const TOP = 150;
const rowsPerCol = Math.ceil(names.length / COLS);
const lastBaseline = TOP + (rowsPerCol - 1) * PITCH;

const widest = names.reduce((a, b) => (short(b).length > short(a).length ? b : a));
const widestPx = short(widest).length * ADVANCE;
const gutter = COL_X[1] - COL_X[0] - widestPx;
if (gutter < 8) {
  throw new Error(
    `«${short(widest)}» шире колонки: ${widestPx.toFixed(0)}px при шаге ` +
      `${COL_X[1] - COL_X[0]}px. Именно так имена налезают друг на друга.`,
  );
}
if (lastBaseline > 529) {
  throw new Error(`${rowsPerCol} строк не помещаются в панель: низ на ${lastBaseline}px`);
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ru = (n) => n.toLocaleString('ru-RU').replace(/ /g, '\u2009');

const LEDE =
  `Покрыты все ${names.length} методов API v5. По умолчанию объявляются девять — ` +
  `те, которыми читают, — плюс ${HELPERS} служебных инструмента.`;
const FIGKEY =
  'манифест по умолчанию · замер сериализацией ответа tools/list · ' +
  'в списке опущен общий префикс direct_';

/**
 * Пропорциональный шрифт точно не измерить без отрисовщика, но оценка с запасом
 * ловит ровно тот дефект, который тут был: строка уезжала за правый край, и
 * увидеть это можно было только глазами на отрендеренной картинке.
 */
function fits(text, size, startX, limitX, what) {
  const width = text.length * size * 0.55;
  if (startX + width > limitX) {
    throw new Error(
      `${what} не помещается: ~${Math.round(width)}px от x=${startX} при пределе ${limitX}. ` +
        `Укоротите строку или уменьшите кегль.`,
    );
  }
}

fits(LEDE, 15, 48, 1164, 'подзаголовок');
fits(FIGKEY, 11.5, 48, 960, 'подпись под числом');


const boxes = [];
const labels = [];
const strikes = [];

names.forEach((name, i) => {
  const col = Math.floor(i / rowsPerCol);
  const row = i % rowsPerCol;
  const x = COL_X[col];
  const y = TOP + row * PITCH;
  const text = short(name);
  const width = text.length * ADVANCE;

  if (core.has(name)) {
    boxes.push(
      `<rect x="${(x - 3).toFixed(1)}" y="${(y - 8.6).toFixed(1)}" ` +
        `width="${(width + 6).toFixed(1)}" height="11.6" fill="${C.keepBox}"/>`,
    );
    labels.push(`<text class="mono name keep" x="${x}" y="${y.toFixed(1)}">${esc(text)}</text>`);
    return;
  }

  labels.push(`<text class="mono name" x="${x}" y="${y.toFixed(1)}">${esc(text)}</text>`);
  // Зачёркивание — линией, а не text-decoration: он по-разному поддержан в
  // отрисовщиках SVG, а линия одинакова везде и её можно анимировать.
  strikes.push({ x1: x, x2: x + width, y: y - 3 });
});

const STEP = 0.03;
const settle = (0.12 + strikes.length * STEP + 0.2).toFixed(2);

/**
 * Одна отрисовка на два выхода.
 *
 * `animate: true` — живой SVG для GitHub: зачёркивания выезжают по CSS.
 * `revealed: n` — статичный кадр для GIF: нарисованы первые n зачёркиваний и
 * ничего больше. Так кадры считаются из тех же данных, а не снимаются с экрана,
 * и разойтись с SVG им негде.
 */
function render({ animate = true, revealed = strikes.length } = {}) {
  const done = animate || revealed >= strikes.length;
  const lines = (animate ? strikes : strikes.slice(0, revealed)).map((s, i) =>
    animate
      ? `<line class="strike s" x1="${s.x1}" y1="${s.y.toFixed(1)}" x2="${s.x2.toFixed(1)}" ` +
        `y2="${s.y.toFixed(1)}" style="animation-delay:${(0.12 + i * STEP).toFixed(2)}s"/>`
      : `<line class="strike" x1="${s.x1}" y1="${s.y.toFixed(1)}" x2="${s.x2.toFixed(1)}" ` +
        `y2="${s.y.toFixed(1)}"/>`,
  );

  const motion = animate
    ? `
  .s { transform-origin: left center; animation: cut .28s ease-out both; }
  @keyframes cut { from { transform: scaleX(0); } to { transform: scaleX(1); } }
  .fadein { animation: fadein .5s ease-out both; animation-delay: ${settle}s; }
  @keyframes fadein { from { opacity: 0; } to { opacity: 1; } }
  .keepbox { animation: fadein .4s ease-out both; animation-delay: .2s; }
  @media (prefers-reduced-motion: reduce) {
    .s, .fadein, .keepbox { animation: none; }
  }`
    : '';

  const figure = done
    ? `<g${animate ? ' class="fadein"' : ''}>
<text class="sans fignum" x="48" y="588" text-decoration="line-through" fill="${C.cut}">${ru(W.all.bytes)} Б</text>
<text class="sans arrow" x="214" y="587">→</text>
<text class="sans fignum" x="247" y="588">${ru(W.core.bytes)} Б</text>
<text class="sans figkey" x="48" y="608">${esc(FIGKEY)}</text>
<text class="sans figkey" x="1152" y="608" text-anchor="end">npx -y yandex-direct-api-mcp</text>
<text class="sans disc" x="48" y="628">Неофициальный клиент API. Яндекс Директ — сервис Яндекса.</text>
</g>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630" role="img" aria-label="tools/list: ${names.length} методов API Яндекс Директа, ${cut.length} вычеркнуты, по умолчанию объявляются ${kept.length} плюс ${HELPERS} служебных инструмента. Манифест по умолчанию ${ru(W.core.bytes)} байт против ${ru(W.all.bytes)} у полного каталога.">
<style>
  .mono { font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace; }
  .sans { font-family: "Golos Text", -apple-system, "Segoe UI", system-ui, sans-serif; }
  .name { font-size: 9px; fill: ${C.cut}; }
  .name.keep { fill: ${C.ink}; font-weight: 600; }
  .eyebrow { font-size: 11.5px; letter-spacing: 1.6px; fill: ${C.cut}; font-weight: 600; }
  .brand { font-size: 14px; fill: ${C.ink}; font-weight: 600; }
  .disc { font-size: 12px; fill: ${C.cut}; }
  .h1 { font-size: 41px; font-weight: 800; fill: ${C.ink}; letter-spacing: -.8px; }
  .lede { font-size: 15px; fill: ${C.lede}; }
  .fignum { font-size: 27px; font-weight: 800; fill: ${C.ink}; letter-spacing: -.4px; }
  .figkey { font-size: 11.5px; fill: ${C.lede}; }
  .arrow { font-size: 20px; fill: ${C.accent}; font-weight: 700; }
  .strike { stroke: ${C.accent}; stroke-width: 1.05; }${motion}
</style>
<rect width="1200" height="630" fill="${C.paper}"/>
<rect x="28" y="118" width="1144" height="420" fill="${C.panel}" stroke="${C.panelEdge}"/>
<rect x="48" y="32" width="11" height="11" rx="1.5" fill="${C.yandex}"/>
<text class="sans brand" x="67" y="42">Яндекс Директ</text>
<text class="sans eyebrow" x="177" y="42">· TOOLS/LIST</text>
<text class="sans h1" x="48" y="86">Вычеркнуть ${cut.length} метода</text>
<text class="sans lede" x="48" y="108">${esc(LEDE)}</text>
<g${animate ? ' class="keepbox"' : ''}>${boxes.join('\n')}</g>
${labels.join('\n')}
<g>${lines.join('\n')}</g>
${figure}
</svg>
`;
}

mkdirSync(join(root, 'assets'), { recursive: true });
writeFileSync(join(root, 'assets/surface.svg'), render());
console.error(
  `assets/surface.svg: ${names.length} методов (${kept.length} оставлено, ${cut.length} вычеркнуто) ` +
    `+ ${HELPERS} служебных · ${ru(W.all.bytes)} Б → ${ru(W.core.bytes)} Б · ` +
    `зазор колонки ${gutter.toFixed(0)}px, низ списка ${lastBaseline.toFixed(0)}px`,
);

/**
 * README живёт не только на GitHub: та же разметка едет на страницу пакета в
 * npm и в агрегаторы MCP. GIF отрисовывается всюду, где вообще показывают
 * картинки; про SVG этого сказать нельзя — часть площадок его санитайзит, и
 * проверить каждую я не могу. Поэтому в разметку идёт GIF, а SVG остаётся
 * вектором-источником. Кадры берутся из той же render(), а не снимаются с
 * экрана: разойтись с SVG им негде.
 */
if (process.argv.includes('--gif')) {
  const need = (bin) => {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' });
    } catch {
      throw new Error(`для --gif нужен ${bin}; без него собирается только SVG`);
    }
  };
  need('rsvg-convert');
  need('magick');

  const dir = mkdtempSync(join(tmpdir(), 'surface-frames-'));
  const FRAMES = 22;
  const files = [];
  try {
    for (let f = 0; f <= FRAMES; f++) {
      const revealed = Math.round((f / FRAMES) * strikes.length);
      const svgPath = join(dir, `f${String(f).padStart(3, '0')}.svg`);
      const pngPath = join(dir, `f${String(f).padStart(3, '0')}.png`);
      writeFileSync(svgPath, render({ animate: false, revealed }));
      execFileSync('rsvg-convert', ['-w', '1200', svgPath, '-o', pngPath]);
      files.push(pngPath);
    }
    const out = join(root, 'assets/surface.gif');
    execFileSync('magick', [
      '-delay', '11', ...files.slice(0, -1),
      // Последний кадр держим долго: это то состояние, ради которого картинка.
      '-delay', '600', files.at(-1),
      '-layers', 'optimize', out,
    ]);
    execFileSync(process.execPath, [join(root, 'tools/gif-play-once.mjs'), out]);
    console.error(
      `assets/surface.gif: ${files.length} кадров, ` +
        `${(statSync(out).size / 1024).toFixed(0)} КБ, проигрывается один раз`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
