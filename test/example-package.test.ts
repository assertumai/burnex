import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import type { CliIo } from '../src/kernel/cli/args.js';
import { run as runCli } from '../src/parts/cli/main.js';
import { ExitCode, type ExitCodeValue } from '../src/kernel/errors.js';
import { buildDashboards } from '../src/parts/ui/dashboardsFile.js';
import { buildRouteTable } from '../src/parts/ui/routesFile.js';
import { listProjectWidgetIds } from '../src/parts/ui/widgets.js';
import { makeProject, withHome, type Project } from './helpers.js';

/**
 * `examples/packages/hello/` (`packages-directory-layer`, «Пример пакета
 * поставляется и проверяется»): копия в слой пакетов проекта проходит схему,
 * а пайплайн примера — `burnex lint`. Каждый вид ресурса примера ещё и
 * находится своим обходом, чтобы пример не отстал от формата молча.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const EXAMPLE = join(ROOT, 'examples', 'packages', 'hello');

async function cli(project: Project, argv: readonly string[]): Promise<{ code: ExitCodeValue; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = { out: (line) => stdout.push(line), err: (line) => stderr.push(line), cwd: project.root };
  const code = await withHome(project.home, () => runCli(argv, io));
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

function projectWithExample(): Project {
  const project = makeProject();
  cpSync(EXAMPLE, join(project.root, '.burnex', 'packages', 'hello'), { recursive: true });
  return project;
}

describe('examples/packages/hello', () => {
  it('package list показывает hello действующим и называет все виды ресурсов', async () => {
    const project = projectWithExample();
    const outcome = await cli(project, ['package', 'list', '--json']);
    assert.equal(outcome.code, ExitCode.ok, outcome.stderr);

    const [item] = (JSON.parse(outcome.stdout) as { packages: { name: string; status: string; provides: string[] }[] }).packages;
    assert.deepEqual([item?.name, item?.status], ['hello', 'ok']);
    assert.deepEqual(item?.provides, ['pipelines', 'steps', 'plugins', 'widgets', 'dashboards', 'routes']);
  });

  it('burnex lint hello:greet проходит без ошибок', async () => {
    const project = projectWithExample();
    const outcome = await cli(project, ['lint', 'hello:greet']);
    assert.equal(outcome.code, ExitCode.ok, `${outcome.stdout}\n${outcome.stderr}`);
    assert.match(outcome.stdout, /^ok: hello:greet/m);
  });

  it('виджет, дашборд и маршрут примера находятся обходами витрины', () => {
    const project = projectWithExample();
    assert.deepEqual(listProjectWidgetIds(project.root, { home: project.home }), ['clock']);

    const dashboards = buildDashboards({ home: project.home, projectRoot: project.root });
    assert.deepEqual(dashboards.failures, []);
    assert.equal(dashboards.dashboards.find((d) => d.id === 'hello')?.package, 'hello');

    const routes = buildRouteTable({ home: project.home, projectRoot: project.root });
    const route = routes.entries.find((entry) => entry.id === 'hello-dashboard');
    assert.equal(route?.definition.path, '/hello');
    assert.equal(route?.sources.path.package, 'hello');
  });

  it('каталожный плагин примера загружается из пакета и вносит свою команду', async () => {
    const project = projectWithExample();
    const outcome = await cli(project, ['hello-note']);
    assert.equal(outcome.code, ExitCode.ok, outcome.stderr);
    assert.equal(outcome.stdout, 'привет из пакета hello');

    const plugins = await cli(project, ['plugins']);
    const line = plugins.stdout.split('\n').find((entry) => entry.includes('hello-note'));
    assert.match(line ?? '', /package hello \(project\)/);
  });
});
