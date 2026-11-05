import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { Context } from 'cordis';

import { bindRouterKernel } from '../src/router';
import { ScheduleList } from '../src/pages/Schedule';
import { TriggerBadge } from '../src/pages/Runs';
import { BUILTIN_SCREENS } from '../src/screens/index';
import type { ScheduleOverview } from '../src/api';

/**
 * Разметка экрана «Schedule» (`ui-schedule-view`) по фикстуре ответа
 * `GET /api/schedule`: таблица, ошибки, обе формы блока сервиса, отсутствие
 * элементов правки; и бейдж `schedule` / `catch-up` в списке прогонов.
 */

// Ссылка на прогон строится по действующей таблице маршрутов — как у `home.test.tsx`.
const TABLE = [
  { id: 'r-run', path: '/runs/:projectKey/:runId', target: { kind: 'screen', id: 'screen-run' } },
];
bindRouterKernel({ routes: { get: () => ({ table: TABLE }) } } as unknown as Context);

function overview(service: ScheduleOverview['service']): ScheduleOverview {
  return {
    generatedAt: '2026-11-01T00:00:00Z',
    service,
    projects: [
      {
        projectKey: 'a',
        projectPath: '/work/a',
        pipelines: [
          {
            pipeline: '.burnex/pipelines/nightly.yml',
            entries: [
              {
                index: 0,
                cron: '0 4 * * *',
                timezone: 'Europe/Berlin',
                defaultTimezone: false,
                next: '2026-11-01T03:00:00.000Z',
                lastRun: {
                  runId: '2026-10-31T09-00-00Z-abc123',
                  moment: '2026-10-31T03:00:00Z',
                  catchup: true,
                  status: 'success',
                },
              },
              { index: 1, cron: '30 6 * * *', timezone: 'Asia/Tokyo', defaultTimezone: true, next: '2026-11-01T06:30:00.000Z' },
              {
                index: 2,
                cron: '0 0 30 2 *',
                timezone: 'Asia/Tokyo',
                defaultTimezone: true,
                error: 'Запись расписания 2: расписание невыполнимо — такой день в этом месяце не наступает',
              },
            ],
          },
        ],
        pipelineErrors: [
          {
            pipeline: '.burnex/pipelines/broken.yml',
            error: 'jobs: ожидался объект',
            errorFile: '.burnex/jobs/shared.yml',
            errorAt: 'jobs.build',
            errorHint: 'Опишите работу словарём с ключом steps',
          },
        ],
      },
      { projectKey: 'b', projectPath: '/work/b', error: 'Не удалось загрузить плагин', pipelines: [], pipelineErrors: [] },
    ],
  };
}

describe('Schedule: разметка по ответу API', () => {
  const html = renderToStaticMarkup(<ScheduleList overview={overview({ present: false })} />);

  it('таблица: пайплайн, выражение, пояс, ближайший момент, последний запуск, догон', () => {
    for (const column of ['Pipeline', 'Expression', 'Timezone', 'Next', 'Last scheduled run', 'Catch-up']) {
      assert.ok(html.includes(`<th>${column}</th>`), column);
    }
    assert.ok(html.includes('.burnex/pipelines/nightly.yml'));
    assert.ok(html.includes('0 4 * * *'));
    assert.ok(html.includes('Europe/Berlin'));
    assert.ok(html.includes('abc123'), 'последний запуск назван идентификатором прогона');
    assert.ok(html.includes('>catch-up<'));
  });

  it('умолчательный пояс отмечен, явный — нет', () => {
    assert.equal(html.split('>default<').length - 1, 2);
    assert.ok(html.includes('Asia/Tokyo'));
  });

  it('ошибка записи — словами линта; пайплайн и проект с ошибкой — строками ошибки', () => {
    assert.ok(html.includes('расписание невыполнимо'));
    assert.ok(html.includes('jobs: ожидался объект'));
    assert.ok(html.includes('.burnex/jobs/shared.yml'));
    assert.ok(html.includes('Опишите работу словарём с ключом steps'));
    assert.ok(html.includes('Не удалось загрузить плагин'));
  });

  it('сервиса нет: фраза о том, что расписания объявлены, но не срабатывают, и ни одного флага', () => {
    assert.ok(html.includes('Schedules are declared, but nothing fires them yet.'));
    for (const flag of ['keep_awake', 'require_network', 'max_catchup_hours']) assert.ok(!html.includes(flag), flag);
  });

  it('сервис есть: включён ли он и три флага со значениями', () => {
    const present = renderToStaticMarkup(
      <ScheduleList
        overview={overview({ present: true, enabled: true, keepAwake: false, requireNetwork: true, maxCatchupHours: 24 })}
      />,
    );
    assert.ok(!present.includes('nothing fires them yet'));
    for (const flag of ['enabled', 'keep_awake', 'require_network', 'max_catchup_hours']) assert.ok(present.includes(flag), flag);
    assert.ok(present.includes('>24<'));
  });

  it('элементов правки нет', () => {
    for (const tag of ['<input', '<button', '<form', '<textarea', '<select']) assert.ok(!html.includes(tag), tag);
  });

  it('пустой ответ — пояснение, а не пустая страница', () => {
    const empty = renderToStaticMarkup(
      <ScheduleList overview={{ projects: [], service: { present: false }, generatedAt: '' }} />,
    );
    assert.ok(empty.includes('No projects'));
  });

  it('экран зарегистрирован в таблице встроенных', () => {
    assert.equal(typeof BUILTIN_SCREENS['screen-schedule'], 'function');
  });
});

describe('Runs: бейдж прогона по расписанию', () => {
  const trigger = { entry: 0, cron: '0 4 * * *', moment: '2026-10-31T03:00:00Z' };

  it('schedule при догоне false, catch-up при true, момент расписания — в подсказке', () => {
    const onTime = renderToStaticMarkup(<TriggerBadge trigger={{ ...trigger, catchup: false }} />);
    assert.ok(onTime.includes('>schedule<'));
    assert.ok(onTime.includes('scheduled for'));

    const late = renderToStaticMarkup(<TriggerBadge trigger={{ ...trigger, catchup: true }} />);
    assert.ok(late.includes('>catch-up<'));
  });

  it('без trigger бейджа нет', () => {
    assert.equal(renderToStaticMarkup(<TriggerBadge trigger={undefined} />), '');
  });
});
