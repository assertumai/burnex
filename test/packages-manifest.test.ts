import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  PackageManifestSchema,
  checkPackageName,
  describePackageFailure,
  readPackageManifest,
  type PackageManifestResult,
} from '../src/parts/packages/manifest.js';
import { tempDir } from './tmp.js';

function manifestText(overrides: Record<string, unknown> = {}, drop: readonly string[] = []): string {
  const doc: Record<string, unknown> = {
    version: 1,
    kind: 'package',
    name: 'hello',
    description: 'Пример',
    package_version: '0.1.0',
    ...overrides,
  };
  for (const key of drop) delete doc[key];
  return Object.entries(doc)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n');
}

function packageDir(name: string, text: string | undefined): string {
  const dir = join(tempDir('packages-manifest-'), name);
  mkdirSync(dir, { recursive: true });
  if (text !== undefined) writeFileSync(join(dir, 'package.yml'), text);
  return dir;
}

function failureOf(result: PackageManifestResult): string {
  assert.equal(result.ok, false);
  return result.ok ? '' : describePackageFailure(result.failure);
}

describe('packages-manifest: манифест пакета', () => {
  it('корректный манифест принят, версия и needs прочитаны', () => {
    const dir = packageDir('hello', manifestText({ package_version: '1.2.3-rc.1+build.5', needs: { backends: ['claude'] } }));
    const result = readPackageManifest(dir);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.manifest.name, 'hello');
    assert.equal(result.manifest.version, '1.2.3-rc.1+build.5');
    assert.deepEqual(result.manifest.needs, { backends: ['claude'], mcp: [], secrets: [], packages: [] });
  });

  it('needs необязателен: все четыре списка пусты', () => {
    const result = readPackageManifest(packageDir('hello', manifestText()));
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.manifest.needs, { backends: [], mcp: [], secrets: [], packages: [] });
  });

  it('неизвестный ключ называет файл и ключ', () => {
    const reason = failureOf(readPackageManifest(packageDir('hello', manifestText({ owner: 'me' }))));
    assert.match(reason, /package\.yml/);
    assert.match(reason, /owner/);
  });

  it('неизвестный ключ внутри needs отклонён', () => {
    const reason = failureOf(readPackageManifest(packageDir('hello', manifestText({ needs: { plugins: ['x'] } }))));
    assert.match(reason, /plugins/);
  });

  it('версия не semver называет поле package_version', () => {
    const result = readPackageManifest(packageDir('hello', manifestText({ package_version: '1.0' })));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.at, 'package_version');
  });

  it('пустое описание отклонено', () => {
    const result = readPackageManifest(packageDir('hello', manifestText({ description: '' })));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.at, 'description');
  });

  it('повтор в needs отклонён', () => {
    const reason = failureOf(readPackageManifest(packageDir('hello', manifestText({ needs: { secrets: ['a', 'a'] } }))));
    assert.match(reason, /needs\.secrets/);
  });

  it('битый YAML — значение отказа, а не исключение', () => {
    const reason = failureOf(readPackageManifest(packageDir('hello', 'name: [unclosed\n')));
    assert.match(reason, /YAML/);
    assert.match(reason, /package\.yml/);
  });

  it('нет файла манифеста — «нет манифеста»', () => {
    const reason = failureOf(readPackageManifest(packageDir('draft', undefined)));
    assert.match(reason, /нет манифеста/);
  });

  it('имя расходится с каталогом — причина называет оба имени', () => {
    const reason = failureOf(readPackageManifest(packageDir('hello', manifestText({ name: 'greet' }))));
    assert.match(reason, /greet/);
    assert.match(reason, /hello/);
  });

  it('зарезервированные имена stepcast и builtin отклонены', () => {
    for (const name of ['stepcast', 'builtin']) {
      const reason = failureOf(readPackageManifest(packageDir(name, manifestText({ name }))));
      assert.match(reason, /зарезервировано/, name);
    }
  });

  it('схема сама отклоняет имя не в kebab-регистре', () => {
    const base = { version: 1, kind: 'package', name: 'hello', description: 'Пример', package_version: '0.1.0' };
    assert.equal(PackageManifestSchema.safeParse(base).success, true);
    assert.equal(PackageManifestSchema.safeParse({ ...base, name: 'Hello' }).success, false);
  });

  it('checkPackageName: схема и резерв', () => {
    assert.equal(checkPackageName('greet'), undefined);
    assert.match(checkPackageName('Bad_Name') ?? '', /kebab/);
    assert.match(checkPackageName('stepcast') ?? '', /зарезервировано/);
  });
});
