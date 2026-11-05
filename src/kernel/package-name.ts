/**
 * Имя пакета движка и адреса его поставки.
 *
 * Пакет называется `burnex`; его подпути — `burnex/plugin`, `burnex/pipeline`,
 * `burnex/step`, `burnex/backends/<имя>`; адрес поставки — `burnex:<имя>`
 * (схема, обёртка, пайплайн, встроенная строка состава). Прежнее имя
 * `stepcast` живёт один выпуск переходного периода (`docs/release.md`,
 * «Переход со stepcast»): подпуть `stepcast/<…>` и адрес `stepcast:<имя>`
 * читаются как свои, но ни в сообщениях, ни в документации не пишутся. Всё,
 * что знает о двух именах, собрано здесь — как у переменных окружения в
 * `env-names.ts`.
 */

export const PACKAGE_NAME = 'burnex';
export const LEGACY_PACKAGE_NAME = 'stepcast';

/** Префикс адреса поставки: `burnex:<имя>`. */
export const PACKAGE_ADDRESS_PREFIX = `${PACKAGE_NAME}:`;
const LEGACY_ADDRESS_PREFIX = `${LEGACY_PACKAGE_NAME}:`;

/** Значение — адрес поставки под любым из двух имён. */
export function isPackagedAddress(value: string): boolean {
  return value.startsWith(PACKAGE_ADDRESS_PREFIX) || value.startsWith(LEGACY_ADDRESS_PREFIX);
}

/** Имя за адресом поставки (`burnex:<имя>`, переходно `stepcast:<имя>`); `undefined` — не адрес. */
export function packagedAddressName(value: string): string | undefined {
  if (value.startsWith(PACKAGE_ADDRESS_PREFIX)) return value.slice(PACKAGE_ADDRESS_PREFIX.length);
  if (value.startsWith(LEGACY_ADDRESS_PREFIX)) return value.slice(LEGACY_ADDRESS_PREFIX.length);
  return undefined;
}

/** Адрес поставки в каноничной форме: `stepcast:<имя>` → `burnex:<имя>`, прочее как есть. */
export function canonicalAddress(value: string): string {
  const name = packagedAddressName(value);
  return name === undefined ? value : `${PACKAGE_ADDRESS_PREFIX}${name}`;
}

/**
 * Спецификатор модуля в каноничной форме: `stepcast` и `stepcast/<подпуть>`
 * → `burnex` и `burnex/<подпуть>`, прочее как есть. Нужен загрузчику состава:
 * пакет в `node_modules` и самоссылка по `exports` знают только новое имя.
 */
export function canonicalSpecifier(specifier: string): string {
  if (specifier === LEGACY_PACKAGE_NAME) return PACKAGE_NAME;
  const prefix = `${LEGACY_PACKAGE_NAME}/`;
  return specifier.startsWith(prefix) ? `${PACKAGE_NAME}/${specifier.slice(prefix.length)}` : specifier;
}
