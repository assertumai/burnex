import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { StepcastError } from '../../kernel/errors.js';
import { readEngineEnv } from '../../kernel/env-names.js';
import { homeRoot } from '../../kernel/dirs.js';

/**
 * Паспорт установки `~/.burnex/install.json`: как поставлен движок и,
 * следовательно, чем его обновлять.
 *
 * Лишние ключи допускаются (`.loose()`): более новый `install.sh` может
 * дописать поле, а старый движок от этого падать не должен.
 */

const managed = z
  .object({
    method: z.literal('managed'),
    repo: z.string(),
    ref: z.string(),
    version: z.string(),
    releases_dir: z.string(),
    /** Каталог лаунчера (`BURNEX_BIN_DIR` установки); у паспортов до этого поля — умолчание install.sh. */
    bin_dir: z.string().optional(),
    installed_at: z.string().optional(),
  })
  .loose();

const checkout = z.object({ method: z.literal('checkout'), dir: z.string() }).loose();

const npm = z.object({ method: z.literal('npm'), package: z.string() }).loose();

export const InstallManifestSchema = z.discriminatedUnion('method', [managed, checkout, npm]);

export type InstallManifest = z.infer<typeof InstallManifestSchema>;
export type ManagedInstall = z.infer<typeof managed>;
export type CheckoutInstall = z.infer<typeof checkout>;
export type NpmInstall = z.infer<typeof npm>;

const METHODS = 'managed|checkout|npm';

const FILE_NAME = 'install.json';

/**
 * Домашний каталог движка: `$BURNEX_HOME` (переходно — `$STEPCAST_HOME`),
 * иначе `~/.burnex`. Пустая переменная считается отсутствующей — как
 * `${BURNEX_HOME:-…}` в install.sh.
 */
export function stepcastHome(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  return readEngineEnv(env, 'HOME') ?? homeRoot(home);
}

/** Путь паспорта: `$BURNEX_HOME/install.json`, иначе `~/.burnex/install.json`. */
export function installManifestPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  return join(stepcastHome(env, home), FILE_NAME);
}

/** Разбор текста паспорта; отказ называет причину и то, что ожидалось. */
export function parseInstallManifest(text: string, file?: string): InstallManifest {
  const where = file === undefined ? {} : { file };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new StepcastError('Паспорт установки не разбирается как JSON', { ...where, cause: error });
  }

  const method = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).method : undefined;
  if (method !== 'managed' && method !== 'checkout' && method !== 'npm') {
    throw new StepcastError(
      method === undefined
        ? `В паспорте установки нет поля method (${METHODS})`
        : `Неизвестный способ установки в паспорте: ${JSON.stringify(method)} (допустимы ${METHODS})`,
      where,
    );
  }

  const parsed = InstallManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join('.') ?? '';
    throw new StepcastError(
      `В паспорте установки (method: ${method}) не задано или неверно поле ${field === '' ? '?' : field}`,
      { ...where, ...(field === '' ? {} : { at: field }) },
    );
  }
  return parsed.data;
}
