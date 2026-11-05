import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';

import { StepcastError } from '../../../kernel/errors.js';
import { describeSchemaFailure } from '../../../kernel/schema-failure.js';
import { SECRET_ENV_PATTERN, SECRET_NAME_PATTERN, WIRING_KEYS } from './schema.js';

export { describeSchemaFailure, type SchemaFailure } from '../../../kernel/schema-failure.js';

/** Прочитать и разобрать YAML-документ, отдав понятную диагностику. */
export function readYamlDocument(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new StepcastError(`Файл не найден: ${path}`, { file: path, cause: error });
    }
    throw new StepcastError(`Не удалось прочитать файл: ${(error as Error).message}`, {
      file: path,
      cause: error,
    });
  }

  try {
    return parseYaml(text);
  } catch (error) {
    throw new StepcastError(`Документ не разбирается как YAML: ${(error as Error).message}`, {
      file: path,
      cause: error,
    });
  }
}

/** Проверить документ схемой, привязав ошибку к файлу и месту внутри него. */
export function validateDocument<T extends z.ZodType>(
  schema: T,
  document: unknown,
  file: string,
): z.infer<T> {
  const parsed = schema.safeParse(document);
  if (parsed.success) return parsed.data;

  const failure = describeSchemaFailure(parsed.error);
  throw new StepcastError(`Документ не соответствует схеме: ${failure.message}`, {
    file,
    ...(failure.at === undefined ? {} : { at: failure.at }),
    hint: 'Сверьтесь с docs/pipeline-format.md',
  });
}

/**
 * Обвязка описывает место работы в конкретном пайплайне, поэтому внутри файла
 * работы её быть не может: иначе работа перестаёт быть переиспользуемой.
 * Схема строгая и такие ключи и так не пропустит, но диагностика по существу
 * полезнее, чем «неизвестный ключ».
 */
export function rejectWiringKeys(document: unknown, file: string): void {
  if (typeof document !== 'object' || document === null) return;
  for (const key of WIRING_KEYS) {
    if (key in (document as Record<string, unknown>)) {
      throw new StepcastError(`Ключ ${key} недопустим внутри файла работы`, {
        file,
        at: key,
        hint: 'Зависимости и условия описываются на месте подключения работы в пайплайне',
      });
    }
  }
}

/**
 * `project.proposals` отклоняется документом пайплайна своим текстом, а не
 * безымянным «неизвестный ключ» от `.strict()` схемы `ProjectSchema`
 * (`stepcast-configuration`, «Ключ в пайплайне»): пайплайн — ровно тот, кого
 * режим доставки ограничивает, и объявить себе `direct` он не вправе
 * (design.md изменения `agent-edits-widgets`, Решение 7). Проверка идёт до
 * схемы, тем же приёмом, что `rejectWiringKeys`.
 */
export function rejectProposalsKeyInPipeline(document: unknown, file: string): void {
  if (typeof document !== 'object' || document === null) return;
  const project = (document as Record<string, unknown>).project;
  if (typeof project !== 'object' || project === null) return;
  if ('proposals' in (project as Record<string, unknown>)) {
    throw new StepcastError('Режим доставки правки кабинета объявляет только конфигурация репозитория', {
      file,
      at: 'project.proposals',
      hint: 'Перенесите значение в .stepcast/config.yml — документ пайплайна его не принимает',
    });
  }
}

const AGENT_SECRET_REFUSAL = 'Агенту секрет не передаётся: ключ secrets есть только у командных шагов и шагов плагинных видов';

/**
 * Места документа, где секрету не место, и объявления не той формы — отказами
 * по существу, до схемы (`secrets-named-providers`, design.md, решения 1 и 2).
 * Строгая схема отклонила бы те же ключи и сама, но сказала бы «неизвестный
 * ключ» и отправила бы автора искать опечатку там, где ключ известен формату
 * и просто стоит не там.
 *
 * `kind` — какой документ проверяется: объявлять секреты может только
 * пайплайн, а файл работы и инлайн-работа пайплайна — нет.
 */
export function rejectSecretMisuse(document: unknown, file: string, kind: 'pipeline' | 'job'): void {
  const record = asRecord(document);
  if (record === undefined) return;

  if (kind === 'job') rejectJobSecretsKey(record, file, 'secrets');
  checkStepsSecrets(record.steps, file, 'steps');
  checkJudgeSecrets(asRecord(record.until)?.check, file, 'until.check');

  if (kind === 'job') return;

  checkSecretDeclarations(record.secrets, file);
  const jobs = asRecord(record.jobs);
  if (jobs === undefined) return;
  for (const [id, entry] of Object.entries(jobs)) {
    const job = asRecord(entry);
    if (job === undefined) continue;
    rejectJobSecretsKey(job, file, `jobs.${id}.secrets`);
    checkStepsSecrets(job.steps, file, `jobs.${id}.steps`);
    checkJudgeSecrets(asRecord(job.until)?.check, file, `jobs.${id}.until.check`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function rejectJobSecretsKey(record: Record<string, unknown>, file: string, at: string): void {
  if (!('secrets' in record)) return;
  throw new StepcastError('Ключ secrets недопустим на уровне работы: секреты объявляются только пайплайном', {
    file,
    at,
    hint: 'Объявите секрет верхним ключом secrets: в документе пайплайна, а в шаге назовите его списком secrets: [имя]',
  });
}

function checkStepsSecrets(rawSteps: unknown, file: string, at: string): void {
  if (!Array.isArray(rawSteps)) return;
  for (const [index, raw] of rawSteps.entries()) {
    const step = asRecord(raw);
    if (step === undefined) continue;
    if ('prompt' in step && 'secrets' in step) {
      throw new StepcastError(AGENT_SECRET_REFUSAL, {
        file,
        at: `${at}.${index}.secrets`,
        hint: 'Секрет нужен командному шагу: вынесите обращение к сервису в шаг run или script',
      });
    }
    checkJudgeSecrets(step.expect, file, `${at}.${index}.expect`);
  }
}

function checkJudgeSecrets(rawList: unknown, file: string, at: string): void {
  if (!Array.isArray(rawList)) return;
  for (const [index, raw] of rawList.entries()) {
    const predicate = asRecord(raw);
    if (predicate === undefined || !('judge' in predicate) || !('secrets' in predicate)) continue;
    throw new StepcastError(AGENT_SECRET_REFUSAL, { file, at: `${at}.${index}.secrets` });
  }
}

function checkSecretDeclarations(rawSecrets: unknown, file: string): void {
  if (rawSecrets === undefined) return;
  const secrets = asRecord(rawSecrets);
  if (secrets === undefined) {
    throw new StepcastError('Ключ secrets — словарь секретов по имени', { file, at: 'secrets' });
  }
  for (const [name, entry] of Object.entries(secrets)) {
    const at = `secrets.${name}`;
    if (!SECRET_NAME_PATTERN.test(name)) {
      throw new StepcastError(`Имя секрета ${name} не соответствует шаблону ${SECRET_NAME_PATTERN.source}`, {
        file,
        at,
        hint: 'Имя секрета — строчные латинские буквы, цифры, дефис и подчёркивание, начиная с буквы',
      });
    }
    const declaration = asRecord(entry);
    if (declaration === undefined || typeof declaration.provider !== 'string' || declaration.provider === '') {
      throw new StepcastError(`Секрет ${name} не называет провайдера`, {
        file,
        at: `${at}.provider`,
        hint: 'Например, provider: env-file; доступные провайдеры показывает burnex plugins',
      });
    }
    const env = declaration.env;
    if (env === undefined) continue;
    if (typeof env !== 'string' || !SECRET_ENV_PATTERN.test(env)) {
      throw new StepcastError(`env секрета ${name} — не имя переменной окружения`, { file, at: `${at}.env` });
    }
    if (env.startsWith('STEPCAST_')) {
      throw new StepcastError(`env секрета ${name} начинается с STEPCAST_: префикс принадлежит движку`, {
        file,
        at: `${at}.env`,
        hint: 'Выберите другое имя переменной: движок не даёт переопределять свои STEPCAST_*',
      });
    }
  }
}
