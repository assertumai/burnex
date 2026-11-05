/**
 * Правила строк env формы запуска (design.md `ui-run-launch-dialog`, Решение
 * 4). Имя, длина и однострочность повторяют схему демона
 * (`src/parts/ui/runLaunch/row.ts`) — её zod-модуль в бандл витрины не
 * тянется, поэтому правила продублированы, а тест сверяет их на тех же
 * примерах, что `test/run-launch.test.ts`. Допустимость ключа проверяет
 * дочерний `burnex run`; форма ловит её заранее по `PipelineView.envNames`,
 * потому что отказ после 202 витрина не видит.
 */

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VALUE_LENGTH = 500;

export interface EnvRow {
  /** Номер строки с нуля — по нему форма ставит ошибку к строке. */
  readonly line: number;
  readonly text: string;
  /** Есть у верной строки. */
  readonly key?: string;
  readonly value?: string;
  /** Есть у ошибочной строки. */
  readonly error?: string;
}

/**
 * Разобрать строки `KEY=VALUE`. Делит по первому `=`, поэтому значение может
 * само содержать `=`; пустое значение допустимо. Пустые строки пропускаются:
 * они не строки env, а воздух между ними.
 */
export function parseEnvLines(lines: readonly string[], declared: readonly string[]): EnvRow[] {
  const rows: EnvRow[] = [];
  const seen = new Set<string>();
  lines.forEach((text, line) => {
    if (text.trim() === '') return;

    const at = text.indexOf('=');
    if (at < 0) {
      rows.push({ line, text, error: 'Expected KEY=VALUE' });
      return;
    }
    const key = text.slice(0, at);
    const value = text.slice(at + 1);

    const error = problemOf(key, value, declared, seen);
    if (error !== undefined) {
      rows.push({ line, text, error });
      return;
    }
    seen.add(key);
    rows.push({ line, text, key, value });
  });
  return rows;
}

function problemOf(
  key: string,
  value: string,
  declared: readonly string[],
  seen: ReadonlySet<string>,
): string | undefined {
  if (!ENV_NAME.test(key)) return 'Name may contain letters, digits and underscore, and must not start with a digit';
  if (/[\n\r]/.test(value)) return 'Value must fit on a single line';
  if (value.length > MAX_VALUE_LENGTH) return `Value is longer than ${MAX_VALUE_LENGTH} characters`;
  if (!declared.includes(key)) {
    return declared.length === 0
      ? `${key} is not declared: this pipeline has no env`
      : `${key} is not declared: the pipeline declares ${declared.join(', ')}`;
  }
  if (seen.has(key)) return `${key} is set twice`;
  return undefined;
}

/** Пары верных строк — то, что уходит в `env` запроса; пустой объект, если верных строк нет. */
export function envOfRows(rows: readonly EnvRow[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const row of rows) if (row.key !== undefined && row.value !== undefined) env[row.key] = row.value;
  return env;
}
