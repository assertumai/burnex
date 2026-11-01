import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { PackagesOverview } from '../src/api';
import { PackagesList } from '../src/pages/Packages';
import { BUILTIN_SCREENS } from '../src/screens/index';

/**
 * Разметка экрана «Packages» (`ui-packages-screen`) по фикстуре ответа
 * `GET /api/packages`: секции слоёв, три статуса, состав с адресами
 * пайплайнов, приглушённый состав неучаствующих пакетов, отказы в карточках.
 */

function overview(extra: Partial<PackagesOverview> = {}): PackagesOverview {
  return {
    layers: { project: '/work/.stepcast/packages', home: '/home/me/.stepcast/packages' },
    packages: [
      {
        name: 'hello',
        layer: 'project',
        dir: '/work/.stepcast/packages/hello',
        status: 'ok',
        version: '0.2.0',
        description: 'Пример пакета',
        provides: ['pipelines', 'widgets', 'dashboards'],
        contents: { pipelines: ['greet'], widgets: ['clock'], dashboards: ['ops'] },
        unmetNeeds: { backends: ['codex'] },
      },
      {
        name: 'other',
        layer: 'project',
        dir: '/work/.stepcast/packages/other',
        status: 'ok',
        version: '0.1.0',
        description: 'Второй',
        provides: ['widgets'],
        contents: { widgets: ['clock'] },
      },
      {
        name: 'hello',
        layer: 'home',
        dir: '/home/me/.stepcast/packages/hello',
        status: 'shadowed',
        shadowedBy: 'project',
        version: '0.1.0',
        description: 'Старый',
        provides: ['steps'],
        contents: { steps: ['old-step'] },
      },
      {
        name: 'broken',
        layer: 'home',
        dir: '/home/me/.stepcast/packages/broken',
        status: 'broken',
        reason: 'package.yml: YAML не разобран',
        provides: ['scripts'],
        contents: { scripts: ['run.sh'] },
      },
    ],
    problems: [
      {
        layer: 'project',
        packages: ['hello', 'other'],
        kind: 'widgets',
        id: 'clock',
        message: 'widgets clock приносят два пакета одного слоя — hello и other',
      },
      {
        layer: 'project',
        packages: ['hello'],
        kind: 'dashboards',
        id: 'ops',
        file: '/work/.stepcast/packages/hello/dashboards/ops.yml',
        message: 'Dashboard ops: cells: ожидался список',
      },
    ],
    ...extra,
  };
}

function section(html: string, title: string): string {
  const start = html.indexOf(`aria-label="${title}"`);
  assert.notEqual(start, -1, title);
  const next = html.indexOf('<section', start + 1);
  return next === -1 ? html.slice(start) : html.slice(start, next);
}

describe('Packages: разметка по ответу API', () => {
  const html = renderToStaticMarkup(<PackagesList overview={overview()} />);

  it('секции Project и Home идут в порядке поиска, пакеты — в своём слое', () => {
    assert.ok(html.indexOf('aria-label="Project"') < html.indexOf('aria-label="Home"'));
    const project = section(html, 'Project');
    assert.ok(project.includes('/work/.stepcast/packages/hello'));
    assert.ok(!project.includes('/home/me/.stepcast/packages/broken'));
    assert.ok(section(html, 'Home').includes('/home/me/.stepcast/packages/broken'));
  });

  it('карточка: имя, версия, описание, каталог и статусы с причиной и затенением', () => {
    for (const text of ['0.2.0', 'Пример пакета', 'in effect', 'shadowed', 'broken']) assert.ok(html.includes(text), text);
    assert.ok(html.includes('package.yml: YAML не разобран'));
    assert.ok(html.includes('Shadowed by a project package'));
  });

  it('состав: пайплайн — адресом пакет:имя, прочие виды — именами', () => {
    assert.ok(html.includes('hello:greet'));
    assert.ok(html.includes('clock'));
    assert.ok(html.includes('run.sh'));
  });

  it('состав сломанного и затенённого пакета приглушён и подписан; у действующего — нет', () => {
    const home = section(html, 'Home');
    assert.equal(home.split('packages-contents-muted').length - 1, 2);
    assert.equal(home.split('Not used in lookup').length - 1, 2);
    assert.ok(!section(html, 'Project').includes('packages-contents-muted'));
  });

  it('unmetNeeds показаны справочно', () => {
    assert.ok(html.includes('backends codex'));
  });

  it('конфликт назван в обеих карточках и называет второй пакет', () => {
    const project = section(html, 'Project');
    assert.equal(project.split('widgets clock (also provided by ').length - 1, 2);
    assert.ok(project.includes('also provided by other'));
    assert.ok(project.includes('also provided by hello'));
  });

  it('отказ дашборда — в карточке своего пакета, с файлом и причиной, и только там', () => {
    const project = section(html, 'Project');
    assert.equal(project.split('Dashboard ops: cells').length - 1, 1);
    assert.ok(project.includes('/work/.stepcast/packages/hello/dashboards/ops.yml'));
    assert.ok(!section(html, 'Home').includes('Dashboard ops'));
  });
});

describe('Packages: пустой слой и ошибка плагинов', () => {
  it('пустой слой — «No packages» и путь каталога слоя', () => {
    const html = renderToStaticMarkup(
      <PackagesList overview={overview({ packages: [], problems: [] })} />,
    );
    assert.equal(html.split('No packages').length - 1, 2);
    assert.ok(html.includes('/work/.stepcast/packages'));
    assert.ok(html.includes('/home/me/.stepcast/packages'));
  });

  it('pluginsError — отдельным предупреждением, остальное показывается', () => {
    const html = renderToStaticMarkup(<PackagesList overview={overview({ pluginsError: 'ядро не собралось' })} />);
    assert.ok(html.includes('Plugin tree was not built'));
    assert.ok(html.includes('ядро не собралось'));
    assert.ok(html.includes('hello:greet'));
  });

  it('экран зарегистрирован под screen-packages', () => {
    assert.equal(typeof BUILTIN_SCREENS['screen-packages'], 'function');
  });
});
