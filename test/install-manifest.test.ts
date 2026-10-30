import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { installManifestPath, parseInstallManifest, stepcastHome } from '../src/parts/install/manifest.js';
import { StepcastError } from '../src/kernel/errors.js';

const MANAGED = {
  method: 'managed',
  repo: 'https://example.com/stepcast.git',
  ref: 'v0.3.0',
  version: '0.3.0',
  releases_dir: '/home/u/.stepcast/releases',
  installed_at: '2026-10-30T00:00:00Z',
};

function reason(text: string): string {
  try {
    parseInstallManifest(text);
  } catch (error) {
    assert.ok(error instanceof StepcastError);
    return error.message;
  }
  return assert.fail('разбор должен был отказать');
}

describe('install-manifest: разбор паспорта', () => {
  it('принимает три способа', () => {
    assert.equal(parseInstallManifest(JSON.stringify(MANAGED)).method, 'managed');
    assert.deepEqual(parseInstallManifest('{"method":"checkout","dir":"/src/stepcast"}'), {
      method: 'checkout',
      dir: '/src/stepcast',
    });
    assert.deepEqual(parseInstallManifest('{"method":"npm","package":"stepcast"}'), {
      method: 'npm',
      package: 'stepcast',
    });
  });

  it('installed_at необязателен', () => {
    const { installed_at: _omit, ...rest } = MANAGED;
    assert.equal(parseInstallManifest(JSON.stringify(rest)).method, 'managed');
  });

  it('лишний ключ не мешает: его допишет более новый install.sh', () => {
    const parsed = parseInstallManifest(JSON.stringify({ ...MANAGED, channel: 'beta' }));
    assert.equal(parsed.method, 'managed');
  });

  it('неизвестный способ называет допустимые', () => {
    const message = reason('{"method":"brew"}');
    assert.match(message, /brew/);
    assert.match(message, /managed\|checkout\|npm/);
  });

  it('нет поля способа — отказ называет поле', () => {
    assert.match(reason('{"dir":"/x"}'), /method/);
  });

  it('checkout без dir называет dir', () => {
    assert.match(reason('{"method":"checkout"}'), /dir/);
  });

  it('битый JSON — внятный отказ', () => {
    assert.match(reason('{не json'), /JSON/);
  });
});

describe('install-manifest: путь паспорта', () => {
  it('берёт STEPCAST_HOME, иначе ~/.stepcast', () => {
    assert.equal(installManifestPath({ STEPCAST_HOME: '/opt/sc' }, '/home/u'), '/opt/sc/install.json');
    assert.equal(installManifestPath({}, '/home/u'), '/home/u/.stepcast/install.json');
    assert.equal(installManifestPath({ STEPCAST_HOME: '' }, '/home/u'), '/home/u/.stepcast/install.json');
  });

  it('пустой STEPCAST_HOME — умолчание и для домашнего каталога: каталог релизов не становится относительным', () => {
    assert.equal(stepcastHome({ STEPCAST_HOME: '' }, '/home/u'), '/home/u/.stepcast');
    assert.equal(stepcastHome({ STEPCAST_HOME: '/opt/sc' }, '/home/u'), '/opt/sc');
  });
});
