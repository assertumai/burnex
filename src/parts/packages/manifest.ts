import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { describeSchemaFailure } from '../../kernel/schema-failure.js';

/**
 * Манифест пакета пользователя (`packages-directory-layer`, design.md,
 * Решение 2): `package.yml` в корне каталога пакета.
 *
 * Слово «пакет» здесь — каталог пользователя, а не npm-пакет движка; пакет
 * движка в этом модуле называется «поставкой».
 */

export const PACKAGE_MANIFEST_FILE = 'package.yml';

/**
 * `stepcast` занят адресом поставки (`stepcast:<имя>`), `builtin` — ключом
 * встроенных виджетов в адресе модуля витрины (`BUILTIN_WIDGETS_KEY`):
 * пакет с таким именем был бы неотличим от них в адресе.
 */
export const RESERVED_PACKAGE_NAMES: readonly string[] = ['stepcast', 'builtin'];

const PACKAGE_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Semver 2.0: три числа без ведущих нулей, необязательные пре-релиз и сборка. */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Список уникальных непустых строк; уникальность `z.toJSONSchema` сам не выводит, и она дописывается в печать. */
const UniqueNamesSchema = z
  .array(z.string().min(1))
  .refine((items) => new Set(items).size === items.length, { message: 'повтор в списке' })
  .meta({ uniqueItems: true });

const PackageNeedsSchema = z
  .object({
    backends: UniqueNamesSchema.optional(),
    mcp: UniqueNamesSchema.optional(),
    secrets: UniqueNamesSchema.optional(),
    packages: UniqueNamesSchema.optional(),
  })
  .strict();

export const PackageManifestSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('package'),
    name: z
      .string()
      .regex(PACKAGE_NAME_PATTERN, { message: 'имя пакета — kebab-slug: строчные латинские буквы, цифры и дефисы' }),
    description: z.string().min(1),
    package_version: z.string().regex(SEMVER_PATTERN, { message: 'версия пакета — semver: MAJOR.MINOR.PATCH' }),
    needs: PackageNeedsSchema.optional(),
  })
  .strict();

export type PackageManifestDocument = z.infer<typeof PackageManifestSchema>;

export interface PackageNeeds {
  readonly backends: readonly string[];
  readonly mcp: readonly string[];
  readonly secrets: readonly string[];
  readonly packages: readonly string[];
}

export interface PackageManifest {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly needs: PackageNeeds;
}

/**
 * Причина отказа пакета: значение, а не исключение — сломанный пакет обязан
 * оставаться записью указателя, а не обрывать обход соседей (Решение 4,
 * «Сломанный пакет падает отдельно»).
 */
export interface PackageFailure {
  readonly file: string;
  readonly at?: string;
  readonly message: string;
}

/** Причина одной строкой: файл, место и текст — то, что видят `package list` и промахи поиска. */
export function describePackageFailure(failure: PackageFailure): string {
  const place = failure.at === undefined ? '' : ` (${failure.at})`;
  return `${failure.file}${place}: ${failure.message}`;
}

export type PackageManifestResult =
  | { readonly ok: true; readonly manifest: PackageManifest }
  | { readonly ok: false; readonly failure: PackageFailure };

function fail(file: string, message: string, at?: string): PackageManifestResult {
  return { ok: false, failure: { file, message, ...(at === undefined ? {} : { at }) } };
}

/**
 * Прочитать и проверить манифест каталога пакета. Проверки, которых схема
 * выразить не может — имя против имени каталога и резерв, — идут здесь же:
 * схема не знает, в каком каталоге лежит документ.
 */
export function readPackageManifest(packageDir: string): PackageManifestResult {
  const file = join(packageDir, PACKAGE_MANIFEST_FILE);

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fail(file, 'нет манифеста');
    return fail(file, `манифест не читается: ${(error as Error).message}`);
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    return fail(file, `манифест не разбирается как YAML: ${(error as Error).message}`);
  }

  const parsed = PackageManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const failure = describeSchemaFailure(parsed.error);
    return fail(file, `манифест не соответствует формату: ${failure.message}`, failure.at);
  }

  const doc = parsed.data;
  if (RESERVED_PACKAGE_NAMES.includes(doc.name)) {
    return fail(file, `имя ${doc.name} зарезервировано за поставкой движка`, 'name');
  }
  const dirName = basename(packageDir);
  if (doc.name !== dirName) {
    return fail(file, `имя пакета ${doc.name} расходится с именем каталога ${dirName}`, 'name');
  }

  return {
    ok: true,
    manifest: {
      name: doc.name,
      description: doc.description,
      version: doc.package_version,
      needs: {
        backends: doc.needs?.backends ?? [],
        mcp: doc.needs?.mcp ?? [],
        secrets: doc.needs?.secrets ?? [],
        packages: doc.needs?.packages ?? [],
      },
    },
  };
}

/** Имя годится в пакет: проходит схему имени и не зарезервировано. Для `package new`, где каталога ещё нет. */
export function checkPackageName(name: string): string | undefined {
  if (!PACKAGE_NAME_PATTERN.test(name)) {
    return `имя пакета ${name} не kebab-slug: строчные латинские буквы, цифры и дефисы`;
  }
  if (RESERVED_PACKAGE_NAMES.includes(name)) return `имя ${name} зарезервировано за поставкой движка`;
  return undefined;
}

/** Форма имени пакета в адресе `<пакет>:<имя>`. */
export function isPackageNameShape(name: string): boolean {
  return PACKAGE_NAME_PATTERN.test(name);
}
