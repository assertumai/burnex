import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { SecretProviderUnavailableError, type SecretProviderInput } from '../src/parts/pipeline/contract.js';
import { createKeychainProvider, KEYCHAIN_PROVIDER } from '../src/parts/pipeline/secrets/keychain.js';
import { describeSecretParamsIssue } from '../src/parts/pipeline/secrets/declaration.js';
import { tempDir } from './tmp.js';

/**
 * Настоящий `security` не вызывается нигде: команда подменяется исполняемой
 * заглушкой, поэтому тест одинаков на Linux и на macOS.
 */

const LEAK = 'ВЫВОД-КОМАНДЫ-НЕ-ДЛЯ-СООБЩЕНИЙ';

interface Stub {
  readonly command: string;
  readonly dir: string;
  readonly argv: () => string[];
}

/** Заглушка: записывает argv в файл, затем исполняет `body` (JS-код процесса). */
function stub(body: string): Stub {
  const dir = tempDir('keychain-');
  const command = join(dir, 'security-stub');
  const argvFile = join(dir, 'argv.json');
  writeFileSync(
    command,
    `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n${body}\n`,
  );
  chmodSync(command, 0o755);
  return { command, dir, argv: () => JSON.parse(readFileSync(argvFile, 'utf8')) as string[] };
}

function input(overrides: Partial<SecretProviderInput> = {}): SecretProviderInput {
  return {
    params: { service: 'github.com', account: 'alice' },
    secret: 'gh-token',
    env: 'GH_TOKEN',
    projectRoot: '/проект',
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function failure(promise: Promise<string>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  return assert.fail('ожидался отказ');
}

describe('провайдер keychain', () => {
  it('значение: argv с -a, -s, -w и снятие одного завершающего перевода строки', async () => {
    const fake = stub(`process.stdout.write('значение-из-связки\\n\\n');`);
    const provider = createKeychainProvider({ command: fake.command, platform: 'darwin' });

    assert.equal(await provider.resolve(input()), 'значение-из-связки\n');
    assert.deepEqual(fake.argv(), ['find-generic-password', '-a', 'alice', '-s', 'github.com', '-w']);
  });

  it('значения параметров не интерпретируются оболочкой', async () => {
    const fake = stub(`process.stdout.write('значение-из-связки');`);
    const provider = createKeychainProvider({ command: fake.command, platform: 'darwin' });
    const account = 'a; touch pwned $(id)';

    await provider.resolve(input({ params: { service: 'svc', account } }));

    assert.deepEqual(fake.argv(), ['find-generic-password', '-a', account, '-s', 'svc', '-w']);
  });

  it('код 44: записи нет, service и account названы, вывод команды в сообщение не попадает', async () => {
    const fake = stub(`process.stdout.write('${LEAK}'); process.stderr.write('${LEAK}'); process.exit(44);`);
    const provider = createKeychainProvider({ command: fake.command, platform: 'darwin' });

    const error = await failure(provider.resolve(input()));
    assert.match(error.message, /нет записи/);
    assert.ok(!(error instanceof SecretProviderUnavailableError), "запись не найдена — не «провайдер недоступен»");
    assert.match(error.message, /service=github\.com/);
    assert.match(error.message, /account=alice/);
    assert.doesNotMatch(error.message, new RegExp(LEAK));
  });

  it('прочий ненулевой код: код возврата и запись, без вывода команды', async () => {
    const fake = stub(`process.stdout.write('${LEAK}'); process.stderr.write('${LEAK}'); process.exit(36);`);
    const provider = createKeychainProvider({ command: fake.command, platform: 'darwin' });

    const error = await failure(provider.resolve(input()));
    assert.match(error.message, /кодом 36/);
    assert.ok(!(error instanceof SecretProviderUnavailableError));
    assert.match(error.message, /account=alice/);
    assert.doesNotMatch(error.message, new RegExp(LEAK));
  });

  it('отсутствующая команда: имя команды и запись', async () => {
    const provider = createKeychainProvider({ command: join(tempDir('keychain-'), 'нет-такой'), platform: 'darwin' });

    const error = await failure(provider.resolve(input()));
    assert.match(error.message, /не найдена/);
    assert.ok(error instanceof SecretProviderUnavailableError);
    assert.match(error.message, /service=github\.com/);
  });

  it('таймаут: процесс остановлен, отказ называет таймаут и запись, без вывода команды', async () => {
    const fake = stub(
      `require('fs').writeFileSync(require('path').join(__dirname, 'pid'), String(process.pid));
       process.stdout.write('${LEAK}'); setTimeout(() => {}, 60000);`,
    );
    const provider = createKeychainProvider({ command: fake.command, platform: 'darwin', timeoutMs: 2000 });

    const error = await failure(provider.resolve(input()));
    assert.match(error.message, /не ответила за 2 с/);
    assert.ok(error instanceof SecretProviderUnavailableError);
    assert.match(error.message, /account=alice/);
    assert.doesNotMatch(error.message, new RegExp(LEAK));

    const pid = Number(readFileSync(join(fake.dir, 'pid'), 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.throws(() => process.kill(pid, 0), 'процесс заглушки должен быть остановлен');
  });

  it('отмена прогона останавливает команду', async () => {
    const fake = stub(`setTimeout(() => {}, 60000);`);
    const provider = createKeychainProvider({ command: fake.command, platform: 'darwin' });
    const controller = new AbortController();

    const pending = failure(provider.resolve(input({ signal: controller.signal })));
    setTimeout(() => controller.abort(), 200);

    const error = await pending;
    assert.match(error.message, /отменён/);
    assert.ok(error instanceof SecretProviderUnavailableError);
  });

  it('не macOS: отказ до запуска команды', async () => {
    const fake = stub(`require('fs').writeFileSync(require('path').join(__dirname, 'ran'), '1'); process.stdout.write('значение');`);
    const provider = createKeychainProvider({ command: fake.command, platform: 'linux' });

    const error = await failure(provider.resolve(input()));
    assert.match(error.message, /только на macOS/);
    assert.ok(error instanceof SecretProviderUnavailableError);
    assert.equal(existsSync(join(fake.dir, 'ran')), false, 'команда не должна запускаться');
    assert.equal(existsSync(join(fake.dir, 'argv.json')), false);
  });

  it('схема: service и account обязательны, лишние ключи отклоняются', () => {
    assert.match(describeSecretParamsIssue(KEYCHAIN_PROVIDER, { service: 'github.com' }) ?? '', /account/);
    assert.match(describeSecretParamsIssue(KEYCHAIN_PROVIDER, { account: 'alice' }) ?? '', /service/);
    assert.match(describeSecretParamsIssue(KEYCHAIN_PROVIDER, { service: 'x', account: '' }) ?? '', /account/);
    assert.match(
      describeSecretParamsIssue(KEYCHAIN_PROVIDER, { service: 'x', account: 'y', label: 'z' }) ?? '',
      /label|additional/i,
    );
    assert.equal(describeSecretParamsIssue(KEYCHAIN_PROVIDER, { service: 'x', account: 'y' }), undefined);
  });
});
