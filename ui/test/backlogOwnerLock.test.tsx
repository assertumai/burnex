import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { Context } from 'cordis';

import { editBacklogItem, moveBacklogItem } from '../src/api';
import type { BacklogItemView, BacklogLockView, BacklogOverview, BacklogProjectView } from '../src/api';
import { BacklogLockNotice, lockNoticeRefreshMs } from '../src/components/BacklogLockNotice';
import { Backlog } from '../src/pages/Backlog';
import { BoardNotices, ItemDetails, ItemDetailsView, Scrum, writeFailure } from '../src/pages/Scrum';
import { bindRouterKernel } from '../src/router';

/**
 * Владелец пункта и блокировка очереди на «Backlog» и «Scrum»
 * (`ui-backlog-owner-and-lock`). Щелчков в тестах витрины нет, поэтому экраны
 * проверяются статическим рендером, а отказ записи — вызовом клиентских
 * функций доски с подставным `fetch`: текст берёт `json()` (`api.ts`), его же
 * кладут в свой `error` оба обработчика `Scrum`.
 */

const RUN_ROUTE = [{ id: 'r-run', path: '/runs/:projectKey/:runId', target: { kind: 'screen', id: 'screen-run' } }];

function bindRoutes(table: readonly unknown[]): void {
  bindRouterKernel({ routes: { get: () => ({ table }) } } as unknown as Context);
}

bindRoutes(RUN_ROUTE);

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const FREE: BacklogLockView = { state: 'free' };

function item(slug: string, overrides: Partial<BacklogItemView> = {}): BacklogItemView {
  return {
    slug,
    status: 'in_progress',
    title: `title of ${slug}`,
    why: 'why',
    doneWhen: 'done',
    group: slug,
    track: '',
    needs: [],
    startedAt: '2026-11-01T11:00:00.000Z',
    sourceFile: 'backlog.md',
    ...overrides,
  };
}

function project(items: readonly BacklogItemView[], lock: BacklogLockView = FREE): BacklogProjectView {
  return {
    projectKey: 'proj',
    projectPath: '/work/proj',
    items,
    failures: [],
    columns: [
      { id: 'todo' },
      { id: 'in_progress' },
      { id: 'done' },
      { id: 'archive' },
    ],
    lock,
  };
}

function overview(items: readonly BacklogItemView[], lock: BacklogLockView = FREE): BacklogOverview {
  return { projects: [project(items, lock)], generatedAt: '2026-11-01T12:00:00.000Z' };
}

const OWNED = item('by-run', { claimedBy: 'run:r-1', ownerRunId: 'r-1' });
const FOREIGN_OWNER = item('by-host', { claimedBy: 'host:build-7' });
const UNOWNED = item('plain');

describe('ui-backlog-owner-and-lock: владелец пункта', () => {
  it('«Backlog»: run:<id> — ссылка на прогон', () => {
    const html = renderToStaticMarkup(<Backlog backlog={overview([OWNED])} navigate={() => {}} />);
    assert.match(html, /href="\/runs\/proj\/r-1"/);
    assert.match(html, /Picked up \/ owner \/ reason/);
  });

  it('«Backlog»: владелец иной формы — текст без ссылки', () => {
    const html = renderToStaticMarkup(<Backlog backlog={overview([FOREIGN_OWNER])} navigate={() => {}} />);
    assert.match(html, /host:build-7/);
    assert.doesNotMatch(html, /href="\/runs\//);
  });

  it('«Backlog»: пункт без claimed_by не получает владельца', () => {
    const html = renderToStaticMarkup(<Backlog backlog={overview([UNOWNED])} navigate={() => {}} />);
    assert.match(html, /picked up/);
    assert.doesNotMatch(html, /owner </);
  });

  it('«Backlog»: у пункта не в работе владелец не показывается', () => {
    const done = item('done-one', { status: 'done', claimedBy: 'run:r-1', ownerRunId: 'r-1' });
    const html = renderToStaticMarkup(<Backlog backlog={overview([done])} navigate={() => {}} />);
    assert.doesNotMatch(html, /href="\/runs\//);
  });

  it('«Scrum»: панель деталей показывает владельца ссылкой и текстом', () => {
    const linked = renderToStaticMarkup(
      <ItemDetails item={OWNED} projectKey="proj" statusBySlug={new Map()} onClose={() => {}} navigate={() => {}} />,
    );
    assert.match(linked, /href="\/runs\/proj\/r-1"/);

    const text = renderToStaticMarkup(
      <ItemDetails
        item={FOREIGN_OWNER}
        projectKey="proj"
        statusBySlug={new Map()}
        onClose={() => {}}
        navigate={() => {}}
      />,
    );
    assert.match(text, /host:build-7/);
    assert.doesNotMatch(text, /href="\/runs\//);

    const none = renderToStaticMarkup(
      <ItemDetails item={UNOWNED} projectKey="proj" statusBySlug={new Map()} onClose={() => {}} navigate={() => {}} />,
    );
    assert.doesNotMatch(none, /owner/);
  });

  it('при выключенном маршруте страницы прогона место называет причину, а не пропадает', () => {
    bindRoutes([]);
    try {
      const html = renderToStaticMarkup(<Backlog backlog={overview([OWNED])} navigate={() => {}} />);
      assert.match(html, /missing-link/);
      assert.match(html, /no route: no active route leads to target screen:screen-run/);
      assert.doesNotMatch(html, /href="\/runs\//);
    } finally {
      bindRoutes(RUN_ROUTE);
    }
  });
});

function held(overrides: Partial<Extract<BacklogLockView, { state: 'held' }>> = {}): BacklogLockView {
  return {
    state: 'held',
    command: 'backlog pick',
    pid: 4242,
    host: 'mac-1',
    acquiredAt: new Date(NOW - 125_000).toISOString(),
    abandoned: false,
    foreignHost: false,
    path: '/work/proj/.git/burnex-backlog.lock',
    ...overrides,
  };
}

describe('ui-backlog-owner-and-lock: предупреждение о блокировке', () => {
  it('занятая блокировка называет команду, pid, машину и возраст — предупреждением, не ошибкой', () => {
    const html = renderToStaticMarkup(<BacklogLockNotice lock={held()} now={NOW} />);
    assert.match(html, /backlog pick/);
    assert.match(html, /4242/);
    assert.match(html, /mac-1/);
    assert.match(html, /2 min ago/);
    assert.doesNotMatch(html, /gone|by hand/);
  });

  it('брошенная блокировка говорит, что следующий писатель снимет её сам', () => {
    const html = renderToStaticMarkup(<BacklogLockNotice lock={held({ abandoned: true })} now={NOW} />);
    assert.match(html, /the process is gone; the next writer will remove the lock/);
  });

  it('блокировка чужой машины называет путь файла и подсказывает удалить его руками', () => {
    const html = renderToStaticMarkup(<BacklogLockNotice lock={held({ foreignHost: true })} now={NOW} />);
    assert.match(html, /another machine/);
    assert.match(html, /\/work\/proj\/\.git\/burnex-backlog\.lock/);
    assert.match(html, /by hand/);
  });

  it('нечитаемый lock-файл называет путь', () => {
    const html = renderToStaticMarkup(
      <BacklogLockNotice lock={{ state: 'unreadable', path: '/work/proj/.git/burnex-backlog.lock' }} now={NOW} />,
    );
    assert.match(html, /unreadable/);
    assert.match(html, /burnex-backlog\.lock/);
  });

  it('у свободной блокировки и у занятой моложе секунды предупреждения нет', () => {
    assert.equal(renderToStaticMarkup(<BacklogLockNotice lock={FREE} now={NOW} />), '');
    const fresh = held({ acquiredAt: new Date(NOW - 300).toISOString() });
    assert.equal(renderToStaticMarkup(<BacklogLockNotice lock={fresh} now={NOW} />), '');
  });

  it('предупреждение стоит в разделе «Backlog» и над колонками «Scrum»', () => {
    const lock = held({ acquiredAt: new Date(Date.now() - 125_000).toISOString() });
    const backlog = renderToStaticMarkup(<Backlog backlog={overview([UNOWNED], lock)} navigate={() => {}} />);
    assert.match(backlog, /mac-1/);
    const scrum = renderToStaticMarkup(<Scrum backlog={overview([UNOWNED], lock)} navigate={() => {}} />);
    assert.match(scrum, /mac-1/);
    assert.ok(scrum.indexOf('mac-1') < scrum.indexOf('scrum-board'), 'предупреждение над колонками');
  });
});

describe('ui-backlog-owner-and-lock: отказ записи по блокировке — дословный текст демона', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const OWNER_TEXT =
    'The backlog is locked by "backlog pick" (pid 4242 on mac-1 since 2026-11-01T11:57:55.000Z): /work/proj/.git/burnex-backlog.lock';

  function conflict(): void {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: OWNER_TEXT }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
  }

  it('409 переноса карточки несёт error ответа без подмены', async () => {
    conflict();
    await assert.rejects(
      moveBacklogItem({ project: 'proj', slug: 'one', column: 'done' }),
      (cause: Error) => cause.message === OWNER_TEXT,
    );
  });

  it('409 сохранения панели несёт error ответа без подмены', async () => {
    conflict();
    await assert.rejects(
      editBacklogItem({ project: 'proj', slug: 'one', fields: { title: 'новое' } }),
      (cause: Error) => cause.message === OWNER_TEXT,
    );
  });

  it('исход записи доски — текст отказа как есть, принятая запись — без текста', async () => {
    conflict();
    assert.equal(await writeFailure(moveBacklogItem({ project: 'proj', slug: 'one', column: 'done' })), OWNER_TEXT);
    assert.equal(await writeFailure(Promise.resolve({})), undefined);
  });

  it('отказ переноса показан над доской, дословно', async () => {
    conflict();
    const failure = await writeFailure(moveBacklogItem({ project: 'proj', slug: 'one', column: 'done' }));
    const notices = renderToStaticMarkup(<BoardNotices lock={FREE} failures={[]} failure={failure} />);
    assert.ok(notices.includes(escapeHtml(OWNER_TEXT)), notices);
    // Те же уведомления стоят в «Scrum» до колонок: место отказа — над доской.
    const scrum = renderToStaticMarkup(<Scrum backlog={overview([UNOWNED], held())} navigate={() => {}} />);
    assert.ok(scrum.indexOf('backlog-lock') < scrum.indexOf('scrum-board'));
  });

  it('отказ сохранения: панель открыта, набранные значения на месте, текст отказа дословно', async () => {
    conflict();
    const failure = await writeFailure(
      editBacklogItem({ project: 'proj', slug: 'plain', fields: { title: 'новый заголовок' } }),
    );
    const html = renderToStaticMarkup(
      <ItemDetailsView
        item={UNOWNED}
        projectKey="proj"
        statusBySlug={new Map()}
        onClose={() => {}}
        navigate={() => {}}
        fields={{
          title: 'новый заголовок',
          why: 'набранное why',
          done_when: 'done',
          group: '',
          track: '',
          repos: '',
          needs: '',
        }}
        error={failure}
        saved={false}
        busy={false}
        onChange={() => {}}
        onSave={() => {}}
      />,
    );
    assert.match(html, /class="scrum-details"/);
    assert.match(html, /value="новый заголовок"/);
    assert.match(html, /набранное why/);
    assert.ok(html.includes(escapeHtml(OWNER_TEXT)), html);
    assert.doesNotMatch(html, />saved</);
  });
});

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

describe('ui-backlog-owner-and-lock: перерисовка предупреждения без нового кадра', () => {
  it('занятая моложе порога ждёт перерисовки ровно до порога', () => {
    const fresh = held({ acquiredAt: new Date(NOW - 300).toISOString() });
    assert.equal(lockNoticeRefreshMs(fresh, NOW), 700);
    // К назначенному моменту предупреждение уже показано.
    assert.notEqual(renderToStaticMarkup(<BacklogLockNotice lock={fresh} now={NOW + 700} />), '');
  });

  it('показанная перерисовывается к смене подписи возраста', () => {
    assert.equal(lockNoticeRefreshMs(held({ acquiredAt: new Date(NOW - 5_250).toISOString() }), NOW), 750);
    assert.equal(lockNoticeRefreshMs(held(), NOW), 55_000);
  });

  it('свободной, нечитаемой и без даты перерисовка не нужна', () => {
    assert.equal(lockNoticeRefreshMs(FREE, NOW), undefined);
    assert.equal(lockNoticeRefreshMs({ state: 'unreadable', path: '/x' }, NOW), undefined);
    assert.equal(lockNoticeRefreshMs(held({ acquiredAt: 'вчера' }), NOW), undefined);
  });

  it('нераспознанный момент взятия показан как есть, без возраста', () => {
    const html = renderToStaticMarkup(<BacklogLockNotice lock={held({ acquiredAt: 'вчера' })} now={NOW} />);
    assert.match(html, /вчера/);
    assert.doesNotMatch(html, /NaN|ago/);
  });
});
