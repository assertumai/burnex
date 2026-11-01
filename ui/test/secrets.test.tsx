import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { SecretsList, STATUS_TITLE } from '../src/pages/Secrets';
import { BUILTIN_SCREENS } from '../src/screens/index';
import type { SecretsOverview } from '../src/api';

/**
 * Разметка экрана «Secrets» (`ui-secrets-screen`) по фикстуре ответа
 * `GET /api/secrets`: три статуса, причины, метка «не используется», полоса
 * провайдеров, строка ошибки пайплайна — и ни одного значения.
 */

/** Значение-маркер: подложено в фикстуру полем, которого в типе ответа нет. */
const MARKER = 'МАРКЕР-ЗНАЧЕНИЯ-ab12cd34';

function overview(): SecretsOverview {
  const withValue = <T extends object>(entry: T): T => ({ ...entry, value: MARKER, secret: MARKER });
  return {
    generatedAt: '2026-11-01T00:00:00Z',
    projects: [
      {
        projectKey: 'a',
        projectPath: '/work/a',
        providers: [
          { name: 'env-file', owner: 'встроенный' },
          { name: 'keychain', owner: 'встроенный' },
          { name: 'vault', owner: 'vault-plugin' },
        ],
        secrets: [
          withValue({
            name: 'gh-token',
            env: 'GH_TOKEN',
            provider: 'env-file',
            params: { file: '.env.local' },
            usedBy: [{ pipeline: 'stepcast.yml', steps: ['build/a', 'check/b'] }],
            unused: false,
            status: 'resolved' as const,
          }),
          withValue({
            name: 'no-key',
            env: 'NO_KEY',
            provider: 'env-file',
            params: { file: '.env.local' },
            usedBy: [{ pipeline: 'stepcast.yml', steps: ['build/a'] }],
            unused: false,
            status: 'not-found' as const,
            reason: 'Секрет no-key не разрешён: в файле .env.local нет ключа NO_KEY',
          }),
          withValue({
            name: 'kc',
            env: 'KC',
            provider: 'keychain',
            params: { service: 'github.com', account: 'alice' },
            usedBy: [],
            unused: true,
            status: 'provider-unavailable' as const,
            reason: 'провайдер keychain доступен только на macOS',
            reasonHint: 'Доступны: env-file',
          }),
        ],
        credentials: [
          withValue({
            backend: 'codex',
            variable: 'OPENAI_API_KEY',
            provider: 'env-file',
            params: { file: '.env.keys' },
            at: 'backends.codex.credentials.OPENAI_API_KEY',
            inUse: false,
            status: 'resolved' as const,
          }),
        ],
        pipelineErrors: [
          {
            pipeline: '.stepcast/pipelines/broken.yml',
            error: 'jobs: ожидался объект',
            errorFile: '.stepcast/jobs/shared.yml',
            errorAt: 'jobs.build',
            errorHint: 'Опишите работу словарём с ключом steps',
          },
        ],
      },
      {
        projectKey: 'b',
        projectPath: '/work/b',
        error: 'Не удалось загрузить плагин',
        errorFile: '.stepcast/config.yml',
        errorAt: 'plugins[0]',
        errorHint: 'Проверьте путь плагина',
        providers: [],
        secrets: [],
        credentials: [],
        pipelineErrors: [],
      },
    ],
  };
}

describe('Secrets: разметка по ответу API', () => {
  const html = renderToStaticMarkup(<SecretsList overview={overview()} />);

  it('значение-маркер в разметке не появляется ни целиком, ни частью', () => {
    assert.ok(!html.includes(MARKER));
    assert.ok(!html.includes(MARKER.slice(0, 12)));
  });

  it('все три статуса и причины словами запуска', () => {
    for (const title of Object.values(STATUS_TITLE)) assert.ok(html.includes(title), title);
    assert.ok(html.includes('в файле .env.local нет ключа NO_KEY'));
    assert.ok(html.includes('доступен только на macOS'));
    assert.ok(html.includes('Доступны: env-file'));
  });

  it('имя, env, провайдер, параметры и где используется', () => {
    assert.ok(html.includes('gh-token'));
    assert.ok(html.includes('GH_TOKEN'));
    assert.ok(html.includes('file=.env.local'));
    assert.ok(html.includes('service=github.com account=alice'));
    assert.ok(html.includes('stepcast.yml'));
    assert.ok(html.includes('build/a, check/b'));
  });

  it('метка «не используется» у объявленного, но не названного секрета — одна', () => {
    // Метка бэкенда ('backend not used') — другая; считается именно секретная.
    assert.equal(html.split('>not used<').length - 1, 1);
  });

  it('полоса провайдеров с владельцем вклада', () => {
    assert.ok(html.includes('vault'));
    assert.ok(html.includes('(vault-plugin)'));
  });

  it('учётные данные бэкендов отдельной таблицей с путём записи', () => {
    assert.ok(html.includes('Backend credentials'));
    assert.ok(html.includes('backends.codex.credentials.OPENAI_API_KEY'));
    assert.ok(html.includes('backend not used'));
  });

  it('пайплайн, который не раскрылся, и проект с ошибкой — строками ошибки', () => {
    assert.ok(html.includes('.stepcast/pipelines/broken.yml'));
    assert.ok(html.includes('jobs: ожидался объект'));
    assert.ok(html.includes('Не удалось загрузить плагин'));
  });

  it('у отказа пайплайна и проекта — файл, место и подсказка, как на «Pipelines»', () => {
    assert.ok(html.includes('.stepcast/jobs/shared.yml'));
    assert.ok(html.includes('jobs.build'));
    assert.ok(html.includes('Опишите работу словарём с ключом steps'));
    assert.ok(html.includes('.stepcast/config.yml'));
    assert.ok(html.includes('plugins[0]'));
    assert.ok(html.includes('Проверьте путь плагина'));
  });

  it('пустой ответ — пояснение, а не пустая страница', () => {
    const empty = renderToStaticMarkup(<SecretsList overview={{ projects: [], generatedAt: '' }} />);
    assert.ok(empty.includes('No projects'));
  });

  it('экран зарегистрирован в таблице встроенных', () => {
    assert.equal(typeof BUILTIN_SCREENS['screen-secrets'], 'function');
  });
});
