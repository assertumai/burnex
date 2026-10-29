import { StepcastError } from '../../../kernel/errors.js';

/**
 * Переопределения env на один прогон (`run --env KEY=VALUE`).
 *
 * Меняются только ключи, объявленные в верхнеуровневом `env:` пайплайна:
 * флаг, которым можно завести любую переменную, обходил бы список `env_deny`
 * и объявленную поверхность окружения шагов. Значение берётся буквально —
 * `${...}` в нём не раскрывается, в отличие от значений самого `env:`:
 * строка, пришедшая из командной строки или тела запроса, не должна читать
 * входы и секреты документа. Перевод строки отвергается, потому что флаг
 * несёт одну пару `ключ=значение`.
 */
export function validateEnvOverrides(
  overrides: Readonly<Record<string, string>>,
  declared: Readonly<Record<string, string>>,
): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(declared, key)) {
      throw new StepcastError(`Переменная ${key} не объявлена в верхнеуровневом env: пайплайна`, {
        hint: `Переопределить можно только объявленные: ${Object.keys(declared).join(', ') || 'их нет'}`,
      });
    }
    if (/[\n\r]/.test(value)) {
      throw new StepcastError(`Значение переменной ${key} должно умещаться в одну строку`);
    }
  }
}
