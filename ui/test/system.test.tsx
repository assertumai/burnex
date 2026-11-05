import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { SystemPanels, updateDisabledReason, type ActionState } from '../src/pages/System';
import { BUILTIN_SCREENS } from '../src/screens/index';
import type { SystemAutostart, SystemOverview, SystemUpdate } from '../src/api';

/**
 * Разметка экрана «System» (`ui-system-health`) по фикстуре ответа
 * `GET /api/system`: состояния автозапуска, неактивные кнопки с причиной,
 * отказы бэкендов и модели без цены.
 */

const LOADED: SystemAutostart = {
  supported: true,
  plist: true,
  loaded: true,
  thisDaemon: true,
  pid: 4242,
  entry: '/h/.burnex/releases/current/dist/src/bin.js',
  entryStable: true,
};

function overview(over: Partial<SystemOverview> = {}): SystemOverview {
  return {
    generatedAt: '2026-11-01T08:00:00Z',
    engine: {
      version: '0.4.0',
      root: '/h/.burnex/releases/0.4.0',
      method: 'managed',
      source: 'manifest',
      managed: { ref: 'v0.4.0', version: '0.4.0', release: '0.4.0', installedAt: '2026-10-01T00:00:00Z' },
    },
    daemon: {
      pid: 4242,
      startedAt: '2026-11-01T07:00:00Z',
      port: 7717,
      projectRoot: '/work/project',
      entry: '/h/.burnex/releases/current/dist/src/bin.js',
      underLaunchd: true,
    },
    autostart: LOADED,
    backends: [
      {
        id: 'claude',
        command: 'claude',
        enabled: true,
        adapter: true,
        commandState: { status: 'found', path: '/usr/local/bin/claude' },
        probe: { status: 'ok', modelCount: 3 },
        refusals: [
          {
            class: 'unauthenticated',
            at: '2026-10-30T10:00:00Z',
            project: '/work/project',
            run: 'run-a',
            job: 'build',
            step: 'a',
            statusCode: 401,
            message: 'Please run /login',
          },
        ],
      },
      {
        id: 'codex',
        command: 'codex',
        enabled: true,
        adapter: false,
        commandState: { status: 'missing' },
        probe: { status: 'not-probed' },
        refusals: [],
      },
    ],
    unattributedRefusals: [
      {
        class: 'rate_limit',
        at: '2026-10-31T10:00:00Z',
        project: '/work/other',
        run: 'run-orphan',
        job: 'deploy',
        step: 'z',
        message: 'quota exhausted',
      },
    ],
    unpriced: {
      asOf: '2026-09-15',
      models: [
        { backend: 'codex', model: 'made-up-model', path: 'backends.codex.model_tiers.fast' },
        { backend: 'cursor', model: null, path: null },
      ],
    },
    ...over,
  };
}

function render(over: {
  overview?: SystemOverview;
  update?: SystemUpdate;
  action?: ActionState;
} = {}): string {
  return renderToStaticMarkup(
    <SystemPanels
      overview={over.overview ?? overview()}
      update={over.update}
      checking={false}
      probing={false}
      action={over.action}
      onCheck={() => undefined}
      onUpdate={() => undefined}
      onToggleAutostart={() => undefined}
      onProbe={() => undefined}
    />,
  );
}

/** Кнопка по подписи: как разметка отдаёт её состояние `disabled`. */
function buttonTag(html: string, label: string): string {
  const match = new RegExp(`<button[^>]*>${label}</button>`).exec(html);
  assert.ok(match, `кнопка «${label}»`);
  return match[0];
}

const AVAILABLE: SystemUpdate = {
  checkedAt: '2026-11-01T08:00:00Z',
  held: false,
  check: { status: 'available', current: 'v0.4.0', latest: 'v0.5.0' },
};

describe('System: карточки', () => {
  it('движок: версия, способ из паспорта, ссылка и релиз; демон: pid, порт, корень, признак агента', () => {
    const html = render();

    assert.ok(html.includes('0.4.0'));
    assert.ok(html.includes('managed'));
    assert.ok(html.includes('install passport'));
    assert.ok(html.includes('v0.4.0'));
    assert.ok(html.includes('4242'));
    assert.ok(html.includes('7717'));
    assert.ok(html.includes('/work/project'));
    assert.ok(html.includes('started by the launchd agent'));
  });
});

describe('System: автозапуск', () => {
  it('включён: переключатель стоит, подсказок нет', () => {
    const html = render();

    assert.ok(html.includes('role="switch" aria-checked="true"') || /aria-checked="true"/.test(html));
    assert.ok(!html.includes('data-hint="not-loaded"'));
    assert.ok(!html.includes('data-hint="pinned-release"'));
    assert.ok(!html.includes('data-hint="unsupported"'));
  });

  it('plist есть, агент не загружен: выключен и отдельная подсказка с командой', () => {
    const html = render({
      overview: overview({ autostart: { supported: true, plist: true, loaded: false, thisDaemon: false } }),
    });

    assert.ok(/aria-checked="false"/.test(html));
    assert.ok(html.includes('data-hint="not-loaded"'));
    assert.ok(html.includes('burnex up --install'));
  });

  it('путь в конкретный релиз: подсказка называет путь и current', () => {
    const html = render({
      overview: overview({
        autostart: { ...LOADED, entry: '/h/.burnex/releases/0.3.0/dist/src/bin.js', entryStable: false },
      }),
    });

    assert.ok(html.includes('data-hint="pinned-release"'));
    assert.ok(html.includes('/h/.burnex/releases/0.3.0/dist/src/bin.js'));
  });

  it('не macOS: переключатель неактивен, причина на месте', () => {
    const html = render({
      overview: overview({ autostart: { supported: false, reason: '--install работает только на macOS' } }),
    });

    assert.ok(html.includes('data-hint="unsupported"'));
    assert.ok(html.includes('работает только на macOS'));
    assert.match(html, /<button[^>]*role="switch"[^>]*disabled/);
  });
});

describe('System: обновление', () => {
  it('до проверки «Update» неактивна: сперва проверить', () => {
    const html = render();

    assert.match(buttonTag(html, 'Update'), /disabled/);
    assert.ok(html.includes('Check for updates first'));
    assert.doesNotMatch(buttonTag(html, 'Check for updates'), /disabled/);
  });

  it('available: «Update» активна, исход называет обе версии, предупреждение о перезапуске есть', () => {
    const html = render({ update: AVAILABLE });

    assert.doesNotMatch(buttonTag(html, 'Update'), /disabled/);
    assert.ok(html.includes('v0.4.0 → v0.5.0'));
    assert.ok(html.includes('restarts the dashboard'));
  });

  it('unknown: «Update» активна, причина проверки названа', () => {
    const html = render({
      update: { checkedAt: '2026-11-01T08:00:00Z', held: false, check: { status: 'unknown', reason: 'Не удалось получить список тегов' } },
    });

    assert.doesNotMatch(buttonTag(html, 'Update'), /disabled/);
    assert.ok(html.includes('Не удалось получить список тегов'));
  });

  it('up-to-date: «Update» неактивна', () => {
    const html = render({
      update: { checkedAt: '2026-11-01T08:00:00Z', held: true, check: { status: 'up-to-date', version: '0.4.0' } },
    });

    assert.match(buttonTag(html, 'Update'), /disabled/);
    assert.ok(html.includes('Up to date'));
    assert.ok(html.includes('remembered by the daemon'));
  });

  it('blocked: «Update» неактивна, причина отказа и подсказка на экране', () => {
    const html = render({
      overview: overview({ engine: { version: '0.4.0', root: '/work/sc', method: 'checkout', source: 'manifest', checkoutDir: '/work/sc' } }),
      update: {
        checkedAt: '2026-11-01T08:00:00Z',
        held: false,
        check: { status: 'blocked', reason: 'В /work/sc есть незакоммиченные правки', hint: 'Закоммитьте или отложите их' },
      },
    });

    assert.match(buttonTag(html, 'Update'), /disabled/);
    assert.ok(html.includes('В /work/sc есть незакоммиченные правки'));
    assert.ok(html.includes('Закоммитьте или отложите их'));
  });

  it('нет паспорта в каталоге релизов: обе кнопки неактивны, причина словами resolveInstallMethod', () => {
    const reason = 'Не удалось определить, как поставлен stepcast: паспорта установки нет';
    const html = render({
      overview: overview({ engine: { version: '0.4.0', root: '/h/.burnex/releases/0.4.0', error: reason } }),
    });

    assert.match(buttonTag(html, 'Update'), /disabled/);
    assert.match(buttonTag(html, 'Check for updates'), /disabled/);
    assert.ok(html.includes('Install method is not known'));
    assert.ok(html.includes(`Update is unavailable: ${reason}`));
  });

  it('updateDisabledReason: no-tags и ошибка проверки тоже отказывают', () => {
    const engine = overview().engine;
    assert.equal(updateDisabledReason(engine, { checkedAt: 'x', held: false, check: { status: 'no-tags', reason: 'нет тегов' } }), 'нет тегов');
    assert.equal(updateDisabledReason(engine, { checkedAt: 'x', held: false, error: 'нет паспорта' }), 'нет паспорта');
  });

  it('ход действия: ожидание, отказ демона, таймаут с журналом и командой для терминала', () => {
    assert.ok(render({ action: { kind: 'update', phase: 'waiting' } }).includes('new PID'));
    assert.ok(render({ action: { kind: 'update', phase: 'rejected', error: 'Another maintenance action is still running' } }).includes('still running'));

    const timeout = render({ action: { kind: 'update', phase: 'timeout', log: ['--- update', 'npm ERR! boom'] } });
    assert.ok(timeout.includes('did not come back'));
    assert.ok(timeout.includes('burnex update'));
    assert.ok(timeout.includes('npm ERR! boom'));
  });

  it('ход действия: процесс вышел без перезапуска — исход по коду выхода, а не таймаут', () => {
    const nothing = render({ action: { kind: 'update', phase: 'finished', exitCode: 0, log: ['уже установлена версия 0.4.0, обновлять нечего'] } });
    assert.ok(nothing.includes('finished without restarting'));
    assert.ok(nothing.includes('обновлять нечего'));
    assert.ok(!nothing.includes('did not come back'));

    const failed = render({ action: { kind: 'update', phase: 'finished', exitCode: 1, log: ['Не удалось получить список тегов'] } });
    assert.ok(failed.includes('exit code 1'));
    assert.ok(failed.includes('burnex update'));
    assert.ok(failed.includes('список тегов'));

    assert.ok(render({ action: { kind: 'autostart', phase: 'finished', exitCode: null } }).includes('killed or not started'));
  });
});

describe('System: бэкенды', () => {
  it('команда найдена с путём, не найдена; проба удержанная и не проводилась', () => {
    const html = render();

    assert.ok(html.includes('/usr/local/bin/claude'));
    assert.ok(html.includes('>found<'));
    assert.ok(html.includes('>missing<'));
    assert.ok(html.includes('3 models'));
    assert.ok(html.includes('not probed'));
    assert.ok(html.includes('no adapter'));
  });

  it('отказ аутентификации — в строке бэкенда: время, прогон, шаг, код и сообщение', () => {
    const html = render();

    assert.ok(html.includes('data-refusal="unauthenticated"'));
    assert.ok(html.includes('run-a'));
    assert.ok(html.includes('build/a'));
    assert.ok(html.includes('HTTP 401'));
    assert.ok(html.includes('Please run /login'));
  });

  it('отказ без бэкенда — отдельной строкой, не в таблице бэкендов', () => {
    const html = render();

    const [table, rest] = html.split('data-section="unattributed"');
    assert.ok(rest?.includes('run-orphan'));
    assert.ok(rest?.includes('quota exhausted'));
    assert.ok(!table?.includes('run-orphan'));
  });

  it('пояснение: авторизация видна только по отказу прогона', () => {
    assert.ok(render().includes('A refusal shows up after the first run that hit it'));
  });

  it('кнопка «Check» есть и активна', () => {
    assert.doesNotMatch(buttonTag(render(), 'Check'), /disabled/);
  });
});

describe('System: модели без цены', () => {
  it('бэкенд, модель, путь в конфигурации и дата каталога', () => {
    const html = render();

    assert.ok(html.includes('made-up-model'));
    assert.ok(html.includes('backends.codex.model_tiers.fast'));
    assert.ok(html.includes('Price catalog as of 2026-09-15'));
  });

  it('бэкенд без названной модели — строка «CLI default model»', () => {
    assert.ok(render().includes('CLI default model'));
  });

  it('перечень пуст — об этом сказано словами', () => {
    const html = render({ overview: overview({ unpriced: { asOf: '2026-09-15', models: [] } }) });

    assert.ok(html.includes('has a price'));
  });
});

describe('System: регистрация', () => {
  it('браузерная половина зарегистрирована под screen-system', () => {
    assert.equal(typeof BUILTIN_SCREENS['screen-system'], 'function');
  });
});
