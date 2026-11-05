import { homedir } from 'node:os';
import { join } from 'node:path';

import { homePackagesDir, projectPackagesDir } from '../../../packages/index.js';
import { sendJson } from '../../daemon/http.js';
import { buildPackageProblems } from '../../packages.js';
import { screenRow, type ApiHandler } from '../registry.js';
import { declaration } from './declaration.js';

/**
 * `GET /api/packages` (`packages-directory-layer`, design.md, Решение 8;
 * `ui-packages-screen`). `packages` — та же сводка, что и `burnex package list
 * --json`; `problems` — отказы ресурсов, которые видит только демон со
 * собранными составами; `layers` — каталоги слоёв, чтобы пустой слой подсказал,
 * куда класть пакет. Только чтение — витрина в каталог пакета не пишет.
 */
const handleGet: ApiHandler = async (_req, res, env) => {
  try {
    const { problems, pluginsError } = await buildPackageProblems(env.watcher, env.kernelCache, env.home);
    const globalPath = join(env.home ?? homedir(), '.stepcast', 'config.yml');
    sendJson(res, 200, {
      packages: env.watcher.currentPackages(),
      problems,
      layers: {
        ...(env.projectRoot === undefined ? {} : { project: projectPackagesDir(env.projectRoot) }),
        home: homePackagesDir(globalPath),
      },
      ...(pluginsError === undefined ? {} : { pluginsError }),
    });
  } catch (error) {
    sendJson(res, 500, { error: (error as Error).message });
  }
};

export const row = screenRow(declaration.id, ['screens', 'api'], (ctx) => {
  ctx.screens.register(declaration);
  ctx.api.register('GET', '/api/packages', handleGet);
});
