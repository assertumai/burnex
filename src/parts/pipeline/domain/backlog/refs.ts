import { statSync } from 'node:fs';
import { resolve } from 'node:path';

import type { BacklogEntry } from './parse.js';

/**
 * Материалы пункта — `goal`, затем `details` в объявленном порядке. Пути
 * записаны от каталога файла очереди.
 */
export function refsOf(entry: BacklogEntry): readonly string[] {
  return [...(entry.data.goal === undefined ? [] : [entry.data.goal]), ...(entry.data.details ?? [])];
}

/**
 * Пути материалов пункта, не называющие существующий обычный файл. Каталог
 * тоже «нет»: материал читается как файл, и каталог на его месте сломал бы
 * сборку контекста позже, чем это можно было сообщить.
 */
export function missingRefs(entry: BacklogEntry, queueDir: string): readonly string[] {
  return refsOf(entry).filter((path) => {
    try {
      return !statSync(resolve(queueDir, path)).isFile();
    } catch {
      return true;
    }
  });
}
