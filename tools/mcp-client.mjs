#!/usr/bin/env node
/**
 * Минимальный клиент к собранному серверу по stdio.
 *
 * Нужен двум потребителям — демонстрации и замеру поверхности, — и обоим нужно
 * ровно одно: поднять `build/index.js` и поговорить с ним тем же JSON-RPC,
 * которым говорит настоящий клиент. Библиотеку клиента сюда не тянем: она
 * добавила бы зависимость ради тридцати строк.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../build/index.js', import.meta.url));

export function startServer(env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  let nextId = 1;
  let buffer = '';
  let stderr = '';

  child.stderr.on('data', (c) => (stderr += c));
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      setTimeout(() => reject(new Error(`нет ответа на ${method}: ${stderr.slice(0, 200)}`)), 30_000);
    });

  return {
    async initialize(name = 'client') {
      const res = await send('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name, version: '0' },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      return res.result;
    },
    async listTools() {
      return (await send('tools/list', {})).result?.tools ?? [];
    },
    async callTool(name, args) {
      return (await send('tools/call', { name, arguments: args })).result;
    },
    stop: () => child.kill(),
    stderr: () => stderr,
  };
}
