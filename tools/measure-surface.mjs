#!/usr/bin/env node
/**
 * Меряет вес поверхности по профилям: сколько байт занимает ответ tools/list.
 *
 * Это не любопытство. Описания всех объявленных инструментов лежат в контексте
 * модели на КАЖДОМ ходу, вызываешь ты их или нет, — то есть поверхность это
 * постоянный налог. Числа для README берутся отсюда, а не из головы: прозой
 * они устаревают молча.
 *
 * Токен не нужен и не используется: сервер объявляет инструменты из спеки,
 * лежащей в пакете, до любого обращения к сети.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../build/index.js', import.meta.url));

/** Один запрос к серверу по stdio, без зависимостей от клиентской библиотеки. */
async function toolsList(env) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, YANDEX_DIRECT_TOKEN: 'x'.repeat(40), ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'measure', version: '0' } } });

  let buffer = '';
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`сервер не ответил. stderr: ${stderr.slice(0, 400)}`));
    }, 20_000);

    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
          continue;
        }
        if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve({ tools: msg.result?.tools ?? [], stderr });
          return;
        }
      }
    });

    child.on('error', reject);
  });
}

const CASES = [
  ['core (умолчание)', {}],
  ['read', { DIRECT_PROFILE: 'read' }],
  ['all, запись выключена', { DIRECT_PROFILE: 'all' }],
  ['all, запись разрешена', { DIRECT_PROFILE: 'all', DIRECT_ALLOW_WRITES: '1' }],
];

console.log('профиль инструментов tools/list, байт   ~токенов');
console.log('─'.repeat(76));
for (const [label, env] of CASES) {
  const { tools } = await toolsList(env);
  const bytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
  // Калибровка 2,17 байта на токен снята на русскоязычных описаниях
  // инструментов. Ходовая эвристика «4 символа на токен» выведена на английском
  // и здесь занижает почти вдвое.
  const tokens = Math.round(bytes / 2.17);
  console.log(
    `${label.padEnd(28)} ${String(tools.length).padStart(9)}   ${String(bytes).padStart(14)}   ${String(tokens).padStart(8)}`,
  );
}
