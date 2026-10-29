import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { StepcastError } from '../../../kernel/errors.js';

/**
 * Автозапуск демона витрины через launchd (macOS).
 *
 * Расписания живут только в поднятом демоне, а после перезагрузки его никто не
 * поднимает. Метка и путь plist постоянны — поэтому `down` находит агент, не
 * читая конфигурации.
 */

export const AGENT_LABEL = 'ai.stepcast.daemon';

/** Всё, что касается системы, внедряется: тест не должен трогать настоящий launchd. */
export interface LaunchdHost {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly uid: number;
  /** Запустить `launchctl`; `status` — код возврата, `stderr` — для сообщения об отказе. */
  readonly launchctl: (args: readonly string[]) => { status: number; stderr: string };
}

export function systemHost(): LaunchdHost {
  return {
    platform: process.platform,
    home: homedir(),
    uid: process.getuid?.() ?? 0,
    launchctl: (args) => {
      const result = spawnSync('launchctl', [...args], { encoding: 'utf8' });
      return { status: result.status ?? 1, stderr: result.stderr ?? '' };
    },
  };
}

export function agentPlistPath(home: string): string {
  return join(home, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
}

export interface PlistOptions {
  /** Интерпретатор и точка входа CLI; демон запускается как `up --foreground`. */
  readonly execPath: string;
  readonly binPath: string;
  readonly workingDirectory: string;
  readonly logFile: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

const str = (value: string): string => `<string>${xmlEscape(value)}</string>`;

/**
 * У launchd своего окружения нет: без `PATH` демон не найдёт агентов и `git`,
 * без `SSH_AUTH_SOCK` — ключей. Поэтому их снимают с оболочки установки, а
 * пустую переменную в plist не пишут — пустой сокет хуже отсутствующего.
 */
export function renderPlist(options: PlistOptions): string {
  const environment: Array<[string, string]> = [];
  for (const key of ['PATH', 'SSH_AUTH_SOCK']) {
    const value = options.env[key];
    if (value !== undefined && value !== '') environment.push([key, value]);
  }

  const args = [options.execPath, options.binPath, 'up', '--foreground'];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>\n  ${str(AGENT_LABEL)}`,
    `  <key>ProgramArguments</key>\n  <array>${args.map((arg) => `\n    ${str(arg)}`).join('')}\n  </array>`,
    `  <key>WorkingDirectory</key>\n  ${str(options.workingDirectory)}`,
    '  <key>RunAtLoad</key>\n  <true/>',
    '  <key>KeepAlive</key>\n  <true/>',
    `  <key>EnvironmentVariables</key>\n  <dict>${environment
      .map(([key, value]) => `\n    <key>${key}</key>\n    ${str(value)}`)
      .join('')}\n  </dict>`,
    `  <key>StandardOutPath</key>\n  ${str(options.logFile)}`,
    `  <key>StandardErrorPath</key>\n  ${str(options.logFile)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** Отказ до любых побочных эффектов: ни файла, ни вызова `launchctl`. */
export function requireMacos(host: LaunchdHost, flag: string): void {
  if (host.platform === 'darwin') return;
  throw new StepcastError(`${flag} работает только на macOS`, {
    hint: 'Автозапуск демона устроен через launchd, которого нет на этой системе',
  });
}

function domain(host: LaunchdHost): string {
  return `gui/${host.uid}`;
}

/** Выгрузить агент. Возвращает, был ли он загружен: отсутствие — не ошибка. */
function bootout(host: LaunchdHost): boolean {
  return host.launchctl(['bootout', `${domain(host)}/${AGENT_LABEL}`]).status === 0;
}

/**
 * Записать plist и загрузить агент. Старый выгружается первым: `bootstrap` уже
 * загруженной метки отказывает, а повторная установка — штатный способ
 * обновить `PATH`.
 */
export function installAgent(host: LaunchdHost, options: PlistOptions): string {
  requireMacos(host, '--install');

  const plist = agentPlistPath(host.home);
  mkdirSync(join(plist, '..'), { recursive: true });
  writeFileSync(plist, renderPlist(options));

  bootout(host);
  const result = host.launchctl(['bootstrap', domain(host), plist]);
  if (result.status !== 0) {
    throw new StepcastError('launchctl не загрузил агент автозапуска', {
      hint: result.stderr.trim() === '' ? `код возврата ${result.status}` : result.stderr.trim(),
    });
  }
  return plist;
}

/**
 * Выгрузить агент, оставив plist: иначе `KeepAlive` поднял бы остановленный
 * демон заново. Вне macOS и без plist ничего не делает — `launchctl` не
 * зовётся, поэтому обычный `down` безопасен везде.
 */
export function unloadAgent(host: LaunchdHost): boolean {
  if (host.platform !== 'darwin' || !existsSync(agentPlistPath(host.home))) return false;
  return bootout(host);
}

/** Выгрузить агент и удалить plist. Возвращает, был ли plist. */
export function removeAgent(host: LaunchdHost): boolean {
  requireMacos(host, '--uninstall');

  const plist = agentPlistPath(host.home);
  const existed = existsSync(plist);
  if (existed) bootout(host);
  rmSync(plist, { force: true });
  return existed;
}
