import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { BUILTIN_OWNER } from '../src/kernel/registry.js';
import { createUiServer, LOOPBACK, type UiServer } from '../src/parts/ui/daemon/server.js';
import { resolveConfig } from '../src/parts/pipeline/config/resolve.js';
import { projectSection, withProjectSection } from '../src/parts/ui/pipelines.js';
import { resolveSecrets } from '../src/parts/pipeline/run/secrets.js';
import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { buildSecrets, type ProjectSecretsView, type SecretsOverview } from '../src/parts/ui/secrets.js';
import { makeJournalBed, seedRun } from './helpers.js';

/**
 * Экран «Secrets» (`ui-secrets-screen`): статусы, сведение записей, причины
 * словами запуска и главное — ни одного байта значения в теле ответа.
 */

/** Значение-маркер: длиннее порога, и по нему ищется любая утечка. */
const MARKER = 'МАРКЕР-ЗНАЧЕНИЯ-ab12cd34';

const KEYCHAIN_MODULE = new URL('../src/parts/pipeline/secrets/keychain.js', import.meta.url).href;

/**
 * Плагин с двумя поддельными keychain: «не macOS» и «записи нет» (код 44).
 * Модуль импортирует собранный `keychain.js` по абсолютному адресу — тот же
 * экземпляр модуля, что у демона, поэтому `instanceof` класса отказа работает.
 */
function keychainPlugin(stub: string): string {
  return `
import { createKeychainProvider } from ${JSON.stringify(KEYCHAIN_MODULE)};
const linux = createKeychainProvider({ command: '/нет/такой/security', platform: 'linux' });
const missing = createKeychainProvider({ command: ${JSON.stringify(stub)}, platform: 'darwin' });
export default {
  name: 'fake-keychain',
  secretProviders: [
    { ...linux, name: 'keychain-linux' },
    { ...missing, name: 'keychain-missing' },
  ],
};
`;
}

const PIPELINE = `kind: pipeline
name: demo
secrets:
  found: { provider: env-file, file: .env.local, env: FOUND_TOKEN }
  nokey: { provider: env-file, file: .env.local, env: NOKEY_TOKEN }
  nofile: { provider: env-file, file: .env.absent, env: NOFILE_TOKEN }
  vaulted: { provider: vault }
  linux: { provider: keychain-linux, service: github.com, account: alice }
  missing: { provider: keychain-missing, service: github.com, account: alice }
  spare: { provider: env-file, file: .env.local, env: FOUND_TOKEN }
jobs:
  build:
    steps:
      - { id: a, run: [echo, ok], secrets: [found, nokey, nofile, vaulted, linux, missing] }
  check:
    needs: [build]
    steps:
      - { id: b, run: [echo, ok], secrets: [found] }
`;

interface Bed {
  readonly runsRoot: string;
  readonly projectRoot: string;
  readonly home: string;
}

function bed(): Bed {
  const { runsRoot, projectRoot, home } = makeJournalBed();
  seedRun(runsRoot, projectRoot, { runId: 'a' });

  const stepcast = join(projectRoot, '.burnex');
  mkdirSync(join(stepcast, 'plugins'), { recursive: true });
  const stub = join(stepcast, 'plugins', 'security-stub');
  writeFileSync(stub, `#!${process.execPath}\nprocess.exit(44);\n`);
  chmodSync(stub, 0o755);
  writeFileSync(join(stepcast, 'plugins', 'fake.mjs'), keychainPlugin(stub));
  writeFileSync(join(stepcast, 'config.yml'), 'plugins: ["./plugins/fake.mjs"]\n');

  writeFileSync(join(projectRoot, '.env.local'), `FOUND_TOKEN=${MARKER}\n`);
  writeFileSync(join(projectRoot, 'burnex.yml'), PIPELINE);

  // Учётные данные бэкендов — только глобальный слой; относительный путь
  // параметров разрешается от каталога глобального конфига.
  writeFileSync(join(home, '.burnex', '.env.keys'), `CLAUDE_KEY=${MARKER}\n`);
  writeFileSync(
    join(home, '.burnex', 'config.yml'),
    `runs:\n  root: ${runsRoot}\nbackends:\n  claude:\n    credentials:\n      CLAUDE_KEY: { provider: env-file, file: .env.keys }\n  codex:\n    credentials:\n      OPENAI_API_KEY: { provider: env-file, file: .env.keys }\n`,
  );
  return { runsRoot, projectRoot, home };
}

function fetchBody(server: UiServer, path: string): Promise<{ code: number; body: string }> {
  return new Promise((resolve, reject) => {
    get({ host: LOOPBACK, port: server.port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ code: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

async function startServer(t: TestContext, options: Bed): Promise<UiServer> {
  const { config } = resolveConfig({ cwd: options.home, home: options.home, projectPath: null });
  const server = await createUiServer({ runsRoot: options.runsRoot, home: options.home, config, port: 0 });
  t.after(() => server.close());
  return server;
}

function onlyProject(overview: SecretsOverview): ProjectSecretsView {
  assert.equal(overview.projects.length, 1);
  return overview.projects[0] as ProjectSecretsView;
}

describe('ui-secrets: GET /api/secrets', () => {
  it('статусы, использование и значение-маркер вне тела ответа', async (t) => {
    const fixture = bed();
    const server = await startServer(t, fixture);

    const { code, body } = await fetchBody(server, '/api/secrets');
    assert.equal(code, 200);
    // Ни целиком, ни частью в любом поле: сериализованное тело не содержит маркера.
    assert.ok(!body.includes(MARKER), 'значение секрета попало в ответ');
    assert.ok(!body.includes(MARKER.slice(0, 12)), 'часть значения секрета попала в ответ');

    const project = onlyProject(JSON.parse(body) as SecretsOverview);
    assert.equal(project.error, undefined);
    const secret = (name: string) => project.secrets.find((entry) => entry.name === name);

    assert.equal(secret('found')?.status, 'resolved');
    assert.equal(secret('found')?.provider, 'env-file');
    assert.equal(secret('found')?.env, 'FOUND_TOKEN');
    assert.deepEqual(secret('found')?.usedBy, [{ pipeline: 'burnex.yml', steps: ['build/a', 'check/b'] }]);
    assert.equal(secret('found')?.unused, false);
    assert.equal(secret('found')?.reason, undefined);

    assert.equal(secret('nokey')?.status, 'not-found');
    assert.match(secret('nokey')?.reason ?? '', /NOKEY_TOKEN/);
    assert.equal(secret('nofile')?.status, 'not-found');
    assert.match(secret('nofile')?.reason ?? '', /\.env\.absent/);

    assert.equal(secret('vaulted')?.status, 'provider-unavailable');
    assert.match(secret('vaulted')?.reason ?? '', /провайдер vault не зарегистрирован/);
    assert.match(secret('vaulted')?.reasonHint ?? '', /Доступны: .*env-file.*keychain/);

    assert.equal(secret('linux')?.status, 'provider-unavailable');
    assert.match(secret('linux')?.reason ?? '', /только на macOS/);
    assert.equal(secret('missing')?.status, 'not-found');
    assert.match(secret('missing')?.reason ?? '', /нет записи service=github\.com, account=alice/);

    // Объявлен, но шаги его не называют: запись есть, со своим статусом.
    assert.equal(secret('spare')?.unused, true);
    assert.deepEqual(secret('spare')?.usedBy, []);
    assert.equal(secret('spare')?.status, 'resolved');
  });

  it('провайдеры реестра проекта с владельцем вклада', async (t) => {
    const fixture = bed();
    const server = await startServer(t, fixture);

    const project = onlyProject(JSON.parse((await fetchBody(server, '/api/secrets')).body) as SecretsOverview);
    const owner = (name: string) => project.providers.find((provider) => provider.name === name)?.owner;
    assert.equal(owner('env-file'), BUILTIN_OWNER);
    assert.equal(owner('keychain'), BUILTIN_OWNER);
    assert.equal(owner('keychain-linux'), 'fake-keychain');
  });

  it('учётные данные бэкендов: путь записи и признак использования бэкенда', async (t) => {
    const fixture = bed();
    const server = await startServer(t, fixture);

    const { body } = await fetchBody(server, '/api/secrets');
    assert.ok(!body.includes(MARKER));
    const project = onlyProject(JSON.parse(body) as SecretsOverview);
    const credential = (backend: string) => project.credentials.find((entry) => entry.backend === backend);

    assert.equal(credential('claude')?.at, 'backends.claude.credentials.CLAUDE_KEY');
    assert.equal(credential('claude')?.status, 'resolved');
    assert.equal(credential('claude')?.provider, 'env-file');
    // Пайплайн проекта агентских шагов не имеет: ни один бэкенд не используется.
    assert.equal(credential('claude')?.inUse, false);
    assert.equal(credential('codex')?.at, 'backends.codex.credentials.OPENAI_API_KEY');
  });

  it('пайплайн, который не раскрылся, идёт строкой ошибки без секретов', async (t) => {
    const fixture = bed();
    mkdirSync(join(fixture.projectRoot, '.burnex', 'pipelines'), { recursive: true });
    writeFileSync(join(fixture.projectRoot, '.burnex', 'pipelines', 'broken.yml'), 'kind: pipeline\nname: broken\njobs: 5\n');
    const server = await startServer(t, fixture);

    const { body } = await fetchBody(server, '/api/secrets');
    assert.ok(!body.includes(MARKER));
    const project = onlyProject(JSON.parse(body) as SecretsOverview);
    assert.equal(project.pipelineErrors.length, 1);
    assert.match(project.pipelineErrors[0]?.pipeline ?? '', /broken\.yml$/);
    assert.ok((project.pipelineErrors[0]?.error ?? '') !== '');
    assert.ok(project.secrets.some((entry) => entry.name === 'found'), 'исправный пайплайн остаётся в ответе');
  });

  it('нечитаемая конфигурация проекта: строка проекта с ошибкой, без записей', async (t) => {
    const fixture = bed();
    writeFileSync(join(fixture.projectRoot, '.burnex', 'config.yml'), 'plugins: ["./plugins/нет-такого.mjs"]\n');
    const server = await startServer(t, fixture);

    const { code, body } = await fetchBody(server, '/api/secrets');
    assert.equal(code, 200);
    const project = onlyProject(JSON.parse(body) as SecretsOverview);
    assert.ok((project.error ?? '') !== '');
    assert.deepEqual(project.secrets, []);
    assert.deepEqual(project.providers, []);
  });

  it('провайдер без таймаута: срок проб отвечает за него, остальные записи — своими статусами', async () => {
    const fixture = bed();
    const stepcast = join(fixture.projectRoot, '.burnex');
    writeFileSync(
      join(stepcast, 'plugins', 'hung.mjs'),
      `export default {
  name: 'hung-vault',
  secretProviders: [{ name: 'hung', schema: { type: 'object' }, resolve: () => new Promise(() => {}) }],
};
`,
    );
    writeFileSync(join(stepcast, 'config.yml'), 'plugins: ["./plugins/fake.mjs", "./plugins/hung.mjs"]\n');
    writeFileSync(
      join(fixture.projectRoot, 'burnex.yml'),
      PIPELINE.replace('secrets:\n', 'secrets:\n  hung: { provider: hung }\n'),
    );
    const { config } = resolveConfig({ cwd: fixture.home, home: fixture.home, projectPath: null });

    const started = Date.now();
    const overview = await buildSecrets(fixture.runsRoot, config, { home: fixture.home, probeTimeoutMs: 300 });
    assert.ok(Date.now() - started < 5000, 'ответ не ждёт провайдера дольше срока');

    const project = onlyProject(overview);
    const hung = project.secrets.find((entry) => entry.name === 'hung');
    assert.equal(hung?.status, 'provider-unavailable');
    assert.match(hung?.reason ?? '', /^Секрет hung не разрешён: провайдер hung не ответил до истечения срока пробы/);
    assert.equal(project.secrets.find((entry) => entry.name === 'found')?.status, 'resolved');
    assert.ok(!JSON.stringify(overview).includes(MARKER));
  });

  it('отменённый запрос: пробы не идут, следующие проекты не обходятся', async () => {
    const fixture = bed();
    const { config } = resolveConfig({ cwd: fixture.home, home: fixture.home, projectPath: null });
    const overview = await buildSecrets(fixture.runsRoot, config, { home: fixture.home, signal: AbortSignal.abort() });
    assert.deepEqual(overview.projects, []);
  });

  it('причина совпадает со словами отказа запуска для той же записи', async () => {
    const fixture = bed();
    const { config } = resolveConfig({ cwd: fixture.home, home: fixture.home, projectPath: null });
    const overview = await buildSecrets(fixture.runsRoot, config, { home: fixture.home });
    const project = onlyProject(overview);

    const overrides = await projectSection(fixture.projectRoot, fixture.home, undefined);
    const forProject = withProjectSection(config, overrides);
    const { pipeline } = expandPipeline({
      pipelinePath: join(fixture.projectRoot, 'burnex.yml'),
      config: forProject,
      registry: overrides.registry,
      inputs: {},
    });

    for (const name of ['nokey', 'nofile', 'vaulted', 'linux', 'missing']) {
      const view = project.secrets.find((entry) => entry.name === name);
      const alone = { ...pipeline, secrets: pipeline.secrets.filter((entry) => entry.name === name) };
      await assert.rejects(
        resolveSecrets({ pipeline: alone, registry: overrides.registry, projectRoot: fixture.projectRoot }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(view?.reason, error.message, name);
          return true;
        },
      );
    }
  });
});
