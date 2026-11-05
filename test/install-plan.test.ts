import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { InstallManifest } from '../src/parts/install/manifest.js';
import { pickLatestTag, planUpdate } from '../src/parts/install/plan.js';

const CURRENT = '/h/.burnex/releases/current';

const MANAGED: InstallManifest = {
  method: 'managed',
  repo: 'https://example.com/stepcast.git',
  ref: 'v0.3.0',
  version: '0.3.0',
  releases_dir: '/h/.burnex/releases',
};

const CHECKOUT: InstallManifest = { method: 'checkout', dir: '/work/stepcast' };

describe('install-plan: managed', () => {
  it('целевая версия равна установленной — обновлять нечего', () => {
    assert.deepEqual(planUpdate(MANAGED, { latestTag: 'v0.3.0' }), {
      kind: 'up-to-date',
      version: '0.3.0',
    });
  });

  it('новый тег — один шаг install.sh из текущего релиза', () => {
    const plan = planUpdate(MANAGED, { latestTag: 'v0.4.0' });
    assert.deepEqual(plan, {
      kind: 'run',
      steps: [
        {
          cmd: 'bash',
          args: [`${CURRENT}/install.sh`, '--repo', MANAGED.method === 'managed' ? MANAGED.repo : '', '--ref', 'v0.4.0'],
          cwd: CURRENT,
          // И под прежним именем: install.sh текущего релиза может знать только его.
          env: { BURNEX_HOME: '/h/.burnex', STEPCAST_HOME: '/h/.burnex' },
        },
      ],
    });
  });

  it('сборка ветки с той же version в package.json — не «уже стоит»: ставится тег', () => {
    const branch: InstallManifest = { ...MANAGED, ref: 'main' } as InstallManifest;
    const plan = planUpdate(branch, { latestTag: 'v0.3.0' });
    assert.equal(plan.kind, 'run');
    assert.deepEqual(plan.kind === 'run' ? plan.steps[0]?.args.slice(-2) : [], ['--ref', 'v0.3.0']);
  });

  it('повторный --ref той же ветки пересобирает: ветка могла уйти вперёд', () => {
    const branch: InstallManifest = { ...MANAGED, ref: 'main' } as InstallManifest;
    assert.equal(planUpdate(branch, { ref: 'main' }).kind, 'run');
  });

  it('нестандартный каталог лаунчера из паспорта передаётся install.sh', () => {
    const custom: InstallManifest = { ...MANAGED, bin_dir: '/opt/bin' } as InstallManifest;
    const plan = planUpdate(custom, { latestTag: 'v0.4.0' });
    assert.deepEqual(plan.kind === 'run' ? plan.steps[0]?.env : undefined, {
      BURNEX_HOME: '/h/.burnex',
      STEPCAST_HOME: '/h/.burnex',
      BURNEX_BIN_DIR: '/opt/bin',
      STEPCAST_BIN_DIR: '/opt/bin',
    });
  });

  it('--ref перекрывает последний тег, в том числе веткой', () => {
    const plan = planUpdate(MANAGED, { ref: 'main', latestTag: 'v0.3.0' });
    assert.equal(plan.kind, 'run');
  });

  it('без тегов и без --ref — отказ с подсказкой про --ref', () => {
    const plan = planUpdate(MANAGED, {});
    assert.equal(plan.kind, 'refuse');
    assert.match(plan.kind === 'refuse' ? (plan.hint ?? '') : '', /--ref/);
  });
});

describe('install-plan: checkout', () => {
  it('чистое дерево: pull, ci, build в каталоге чекаута', () => {
    const plan = planUpdate(CHECKOUT, { dirty: false });
    assert.deepEqual(plan, {
      kind: 'run',
      steps: [
        { cmd: 'git', args: ['pull', '--ff-only'], cwd: '/work/stepcast' },
        { cmd: 'npm', args: ['ci'], cwd: '/work/stepcast' },
        { cmd: 'npm', args: ['run', 'build'], cwd: '/work/stepcast' },
      ],
    });
  });

  it('грязное дерево — отказ до любых шагов', () => {
    const plan = planUpdate(CHECKOUT, { dirty: true });
    assert.equal(plan.kind, 'refuse');
  });

  it('--ref: fetch и checkout вместо pull', () => {
    const plan = planUpdate(CHECKOUT, { ref: 'v0.5.0', dirty: false });
    assert.equal(plan.kind, 'run');
    const steps = plan.kind === 'run' ? plan.steps : [];
    assert.deepEqual(
      steps.map((step) => [step.cmd, ...step.args].join(' ')),
      [
        'git fetch --tags',
        'git checkout v0.5.0',
        'sh -c if git symbolic-ref -q HEAD >/dev/null; then git pull --ff-only; fi',
        'npm ci',
        'npm run build',
      ],
    );
    assert.ok(steps.every((step) => step.cwd === '/work/stepcast'));
  });
});

describe('install-plan: checkout с отцеплённым HEAD', () => {
  it('без --ref — отказ с подсказкой про --ref, а не падение git pull', () => {
    const plan = planUpdate(CHECKOUT, { dirty: false, detached: true });
    assert.equal(plan.kind, 'refuse');
    assert.match(plan.kind === 'refuse' ? (plan.hint ?? '') : '', /--ref/);
  });

  it('с --ref — checkout допустим и с отцеплённого HEAD', () => {
    assert.equal(planUpdate(CHECKOUT, { ref: 'main', dirty: false, detached: true }).kind, 'run');
  });
});

describe('install-plan: npm', () => {
  const NPM: InstallManifest = { method: 'npm', package: 'stepcast' };

  it('без --ref — latest', () => {
    assert.deepEqual(planUpdate(NPM, {}), {
      kind: 'run',
      steps: [{ cmd: 'npm', args: ['install', '-g', 'stepcast@latest'] }],
    });
  });

  it('--ref — версия или dist-tag', () => {
    const plan = planUpdate(NPM, { ref: '0.2.0' });
    assert.deepEqual(plan.kind === 'run' ? plan.steps[0]?.args : [], ['install', '-g', 'stepcast@0.2.0']);
  });
});

describe('install-plan: последний тег', () => {
  const sha = 'a'.repeat(40);
  const line = (tag: string): string => `${sha}\trefs/tags/${tag}`;

  it('сравнивает по числам и пропускает пре-релизы', () => {
    const output = ['v0.9.0', 'v0.10.0', 'v0.11.0-rc.1', 'v0.2.7'].map(line).join('\n');
    assert.equal(pickLatestTag(output), 'v0.10.0');
  });

  it('игнорирует теги не вида vX.Y.Z; пустой вывод — undefined', () => {
    assert.equal(pickLatestTag(['latest', 'v1.2', 'release-3'].map(line).join('\n')), undefined);
    assert.equal(pickLatestTag(''), undefined);
  });
});
