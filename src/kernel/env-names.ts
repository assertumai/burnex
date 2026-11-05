/**
 * Имена собственных переменных окружения движка.
 *
 * Движок называется `burnex`, и его переменные — `BURNEX_*`. Прежнее имя
 * `STEPCAST_*` живёт один выпуск переходного периода (`docs/release.md`,
 * «Переход со stepcast»): шагам и дочерним процессам обе формы выставляются
 * с одним значением, а свои настройки движок читает по новому имени и лишь
 * при его отсутствии — по старому, предупредив в stderr один раз за процесс.
 * Всё, что знает о двух префиксах, собрано здесь: когда `STEPCAST_*`
 * перестанут читаться, меняется этот модуль, а не десяток мест.
 */

export const ENV_PREFIX = 'BURNEX_';
export const LEGACY_ENV_PREFIX = 'STEPCAST_';

const PREFIXES: readonly string[] = [ENV_PREFIX, LEGACY_ENV_PREFIX];

/** Имя переменной движка: `BURNEX_<SUFFIX>`. */
export function envName(suffix: string): string {
  return `${ENV_PREFIX}${suffix}`;
}

/** Прежнее имя той же переменной: `STEPCAST_<SUFFIX>`. */
export function legacyEnvName(suffix: string): string {
  return `${LEGACY_ENV_PREFIX}${suffix}`;
}

/** Переменная принадлежит движку — под любым из двух префиксов. */
export function isEngineVariable(name: string): boolean {
  return PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Дополнить набор переменных движка прежними именами: каждая `BURNEX_X`
 * получает двойника `STEPCAST_X` с тем же значением. Чужие имена (без
 * префикса, `NEEDS_*`) проходят как есть.
 */
export function withLegacyNames(variables: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(variables)) {
    out[name] = value;
    if (name.startsWith(ENV_PREFIX)) out[legacyEnvName(name.slice(ENV_PREFIX.length))] = value;
  }
  return out;
}

const warned = new Set<string>();

/**
 * Прочитать переменную движка по суффиксу: сначала `BURNEX_X`, затем
 * `STEPCAST_X`. Пустое значение считается отсутствующим — как `${X:-…}` в
 * оболочке. Чтение по прежнему имени предупреждает один раз за процесс и
 * только для входных настроек (`warn`): переменные, которые движок сам
 * выставил шагу под обоими именами, предупреждения не заслуживают.
 */
export function readEngineEnv(
  env: Readonly<Record<string, string | undefined>>,
  suffix: string,
  options: { readonly warn?: boolean } = {},
): string | undefined {
  const current = env[envName(suffix)];
  if (current !== undefined && current !== '') return current;
  const legacy = env[legacyEnvName(suffix)];
  if (legacy === undefined || legacy === '') return undefined;
  if (options.warn !== false && !warned.has(suffix)) {
    warned.add(suffix);
    process.stderr.write(
      `burnex: переменная ${legacyEnvName(suffix)} переименована в ${envName(suffix)}; прежнее имя читается последний выпуск\n`,
    );
  }
  return legacy;
}

/** Только для тестов: забыть, о чём уже предупреждали. */
export function resetEngineEnvWarnings(): void {
  warned.clear();
}
