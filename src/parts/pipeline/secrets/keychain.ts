import { execFile } from 'node:child_process';

import type { SecretProviderContribution } from '../contract.js';

/**
 * Встроенный провайдер секретов `keychain` (`secrets-keychain-provider`,
 * design.md, решение 1): значение — вывод
 * `security find-generic-password -a <account> -s <service> -w`.
 *
 * `account` обязателен намеренно: `security` без `-a` берёт первую подходящую
 * запись, и на машине с двумя учётками одного сервиса прогон молча получил бы
 * чужой токен.
 */

export interface KeychainProviderOptions {
  /** Исполняемая команда; подменяется только кодом внутри процесса движка (тест, плагин). */
  readonly command?: string;
  readonly platform?: NodeJS.Platform;
  readonly timeoutMs?: number;
}

/**
 * Заблокированная связка ключей поднимает системный диалог, и без таймаута
 * старт неинтерактивного прогона держался бы бесконечно; 5 с хватает на
 * холодный старт `securityd`.
 */
export const KEYCHAIN_TIMEOUT_MS = 5000;

/** Код `security`, когда записи нет (`errSecItemNotFound`). */
const EXIT_ITEM_NOT_FOUND = 44;

/**
 * Сообщения отказов не включают stdout и stderr команды: первый содержит
 * чужие секреты записей, второй — подробности связки ключей, которым в
 * журнале и выводе запуска делать нечего.
 */
export function createKeychainProvider(options: KeychainProviderOptions = {}): SecretProviderContribution {
  const command = options.command ?? 'security';
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? KEYCHAIN_TIMEOUT_MS;

  return {
    name: 'keychain',
    schema: {
      type: 'object',
      properties: {
        service: { type: 'string', minLength: 1 },
        account: { type: 'string', minLength: 1 },
      },
      required: ['service', 'account'],
      additionalProperties: false,
    },
    async resolve({ params, secret, signal }) {
      const service = params.service as string;
      const account = params.account as string;
      const entry = `service=${service}, account=${account}`;

      if (platform !== 'darwin') {
        throw new Error(`секрет ${secret}: провайдер keychain доступен только на macOS (${entry})`);
      }

      return new Promise<string>((resolvePromise, reject) => {
        // stdin у execFile — канал, а не терминал; закрываем его, чтобы команда не ждала ввода.
        const child = execFile(
          command,
          ['find-generic-password', '-a', account, '-s', service, '-w'],
          { timeout: timeoutMs, signal, encoding: 'utf8' },
          (error, stdout) => {
            if (error === null) {
              resolvePromise(String(stdout).replace(/\n$/, ''));
              return;
            }
            // У execFile `code` — код возврата числом либо строка errno (`ENOENT`).
            const failure = error as Error & { killed?: boolean; code?: string | number };
            if (failure.name === 'AbortError' || failure.killed === true) {
              reject(
                new Error(
                  `секрет ${secret}: ${command} не ответила за ${timeoutMs / 1000} с или запуск отменён (${entry}); связка ключей заблокирована? Разблокируйте её или разрешите доступ ${command} к записи («Always Allow»)`,
                ),
              );
              return;
            }
            if (failure.code === 'ENOENT') {
              reject(new Error(`секрет ${secret}: команда ${command} не найдена (${entry})`));
              return;
            }
            if (failure.code === EXIT_ITEM_NOT_FOUND) {
              reject(new Error(`секрет ${secret}: в связке ключей нет записи ${entry}`));
              return;
            }
            reject(new Error(`секрет ${secret}: ${command} завершилась с кодом ${String(failure.code)} (${entry})`));
          },
        );
        child.stdin?.end();
      });
    },
  };
}

export const KEYCHAIN_PROVIDER: SecretProviderContribution = createKeychainProvider();
