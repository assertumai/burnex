import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyDeclarativePlugin } from '../src/kernel/load.js';
import { BurnexError } from '../src/kernel/errors.js';
import { availableNames, contributionOwner, registryFromKernel } from '../src/kernel/registry.js';
import { createBuiltinKernel } from '../src/parts/builtin.js';
import {
  DECLARATIVE_CONTRIBUTION_FIELDS,
  BurnexPluginSchema,
  type SecretProviderContribution,
} from '../src/parts/pipeline/contract.js';
import { ENV_FILE_PROVIDER } from '../src/parts/pipeline/secrets/envFile.js';
import { makeProject } from './helpers.js';

/** Вклад провайдера, годный для реестра: содержимое здесь не важно. */
function provider(name: string): SecretProviderContribution {
  return { name, schema: { type: 'object' }, resolve: async () => 'значение-секрета' };
}

function resolveEnvFile(root: string, params: Record<string, unknown>, env = 'GH_TOKEN'): Promise<string> {
  return ENV_FILE_PROVIDER.resolve({
    params,
    secret: 'gh-token',
    env,
    projectRoot: root,
    signal: new AbortController().signal,
  });
}

describe('secret-providers: реестр', () => {
  it('env-file и keychain числятся среди провайдеров встроенного реестра, владелец — встроенный', () => {
    const registry = registryFromKernel(createBuiltinKernel());
    assert.deepEqual(availableNames(registry, 'secretProviders'), ['env-file', 'keychain']);
    assert.equal(contributionOwner(registry, 'secretProviders', 'env-file'), 'встроенный');
    assert.equal(contributionOwner(registry, 'secretProviders', 'keychain'), 'встроенный');
  });

  it('плагин вносит провайдер, и владельцем числится он', async () => {
    const kernel = createBuiltinKernel();
    await applyDeclarativePlugin(
      kernel,
      { name: 'vault', secretProviders: [provider('vault')] },
      '/модуль/vault.js',
      DECLARATIVE_CONTRIBUTION_FIELDS,
    );
    const registry = registryFromKernel(kernel);
    assert.deepEqual(availableNames(registry, 'secretProviders'), ['env-file', 'keychain', 'vault']);
    assert.equal(contributionOwner(registry, 'secretProviders', 'vault'), 'vault');
  });

  it('плагин не может занять имя встроенного провайдера', async () => {
    const kernel = createBuiltinKernel();
    await assert.rejects(
      () =>
        applyDeclarativePlugin(
          kernel,
          { name: 'самозванец', secretProviders: [provider('env-file')] },
          '/м.js',
          DECLARATIVE_CONTRIBUTION_FIELDS,
        ),
      (error: unknown) => error instanceof BurnexError && /env-file/.test(error.message),
    );
  });

  it('вклад с битой формой отклоняется при загрузке, отказ называет поле', () => {
    const noResolve = BurnexPluginSchema.safeParse({
      name: 'p',
      secretProviders: [{ name: 'vault', schema: {} }],
    });
    assert.equal(noResolve.success, false);
    assert.match(JSON.stringify(noResolve.error?.issues), /resolve/);

    const badName = BurnexPluginSchema.safeParse({
      name: 'p',
      secretProviders: [{ name: 'Не Слаг', schema: {}, resolve: async () => 'x' }],
    });
    assert.equal(badName.success, false);
    assert.match(JSON.stringify(badName.error?.issues), /имя провайдера секретов/);

    const ok = BurnexPluginSchema.safeParse({ name: 'p', secretProviders: [provider('vault')] });
    assert.equal(ok.success, true);
  });
});

describe('secret-providers: env-file', () => {
  it('читает значение по ключу, умолчание ключа — env секрета', async () => {
    const project = makeProject({ '.env.local': '# токен\nGH_TOKEN=abcdefgh12345\nOTHER="кавычки-значение"\n' });
    assert.equal(await resolveEnvFile(project.root, { file: '.env.local' }), 'abcdefgh12345');
    assert.equal(await resolveEnvFile(project.root, { file: '.env.local', key: 'OTHER' }), 'кавычки-значение');
  });

  it('относительный путь берётся от корня проекта, абсолютный — как есть', async () => {
    const project = makeProject({ 'secrets/.env': 'GH_TOKEN=от-корня-проекта\n' });
    assert.equal(await resolveEnvFile(project.root, { file: 'secrets/.env' }), 'от-корня-проекта');
    assert.equal(await resolveEnvFile('/нигде', { file: project.path('secrets/.env') }), 'от-корня-проекта');
  });

  it('отсутствующий файл — отказ с именем файла и секрета, не пустое значение', async () => {
    const project = makeProject();
    await assert.rejects(
      () => resolveEnvFile(project.root, { file: '.env.нет' }),
      (error: unknown) => error instanceof Error && /\.env\.нет/.test(error.message) && /gh-token/.test(error.message),
    );
  });

  it('отсутствующий ключ — отказ с именем файла и ключа', async () => {
    const project = makeProject({ '.env': 'ДРУГОЙ=значение\n' });
    await assert.rejects(
      () => resolveEnvFile(project.root, { file: '.env', key: 'GITHUB_TOKEN' }),
      (error: unknown) => error instanceof Error && /\.env/.test(error.message) && /GITHUB_TOKEN/.test(error.message),
    );
    await assert.rejects(
      () => resolveEnvFile(project.root, { file: '.env' }, 'GH_TOKEN'),
      (error: unknown) => error instanceof Error && /GH_TOKEN/.test(error.message),
    );
  });
});
