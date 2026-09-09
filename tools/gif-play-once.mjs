#!/usr/bin/env node
/**
 * Убирает из GIF блок бесконечного зацикливания — файл проигрывается один раз
 * и замирает на последнем кадре.
 *
 * Зачем. WCAG 2.2, SC 2.2.2 «Pause, Stop, Hide» (уровень A): автоматически
 * запущенное движение дольше пяти секунд рядом с другим содержимым обязано
 * иметь механизм паузы. В README такого механизма нет, поэтому единственный
 * доступный путь — чтобы анимация закончилась и остановилась (техника W3C
 * G152). VHS и большинство конвертеров пишут бесконечный цикл по умолчанию.
 *
 * Почему правка байтовая, а не перекодировка. Пережать GIF через ffmpeg —
 * значит заново квантовать палитру и потерять качество там, где менять надо
 * ровно один управляющий блок. Здесь вырезается Application Extension
 * NETSCAPE2.0 целиком: без него плеер играет один проход.
 *
 * Запуск: node tools/gif-play-once.mjs <файл.gif>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('нужен путь к .gif');
  process.exit(1);
}

const buf = readFileSync(file);
const marker = buf.indexOf(Buffer.from('NETSCAPE2.0', 'ascii'));

if (marker < 0) {
  console.error(`${file}: блока зацикливания нет — файл и так играет один раз`);
  process.exit(0);
}

// Блок целиком: 0x21 0xFF 0x0B "NETSCAPE2.0" 0x03 0x01 <2 байта счётчика> 0x00.
// Начало — за три байта до строки (интродьюсер, метка, длина).
const start = marker - 3;
const end = marker + 'NETSCAPE2.0'.length + 5;

if (buf[start] !== 0x21 || buf[start + 1] !== 0xff || buf[end - 1] !== 0x00) {
  console.error(`${file}: разметка блока не та, что ожидалась, — не трогаю`);
  process.exit(1);
}

const out = Buffer.concat([buf.subarray(0, start), buf.subarray(end)]);
writeFileSync(file, out);
console.error(`${file}: зацикливание снято (${buf.length} → ${out.length} байт)`);
