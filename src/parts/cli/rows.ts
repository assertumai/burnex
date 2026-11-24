import type { CommandRow } from '../../kernel/cli/commandRow.js';

import { row as run } from '../pipeline/commands/run.js';
import { row as resume } from '../pipeline/commands/resume.js';
import { row as diff } from '../pipeline/commands/diff.js';
import { row as decide } from '../pipeline/commands/decide.js';
import { row as propose } from '../pipeline/commands/propose.js';
import { row as widgets } from '../ui/commands/widgets.js';
import { row as apply } from '../pipeline/commands/apply.js';
import { row as lint } from '../pipeline/commands/lint.js';
import { row as status } from '../pipeline/commands/status.js';
import { row as logs } from '../pipeline/commands/logs.js';
import { row as config } from '../pipeline/commands/config.js';
import { row as schema } from '../pipeline/commands/schema.js';
import { row as plugins } from './commands/plugins.js';
import { row as packageRow } from '../packages/commands/package.js';
import { row as gc } from '../pipeline/commands/gc.js';
import { row as init } from '../pipeline/commands/init.js';
import { row as context } from '../pipeline/commands/context.js';
import { row as up } from '../ui/commands/up.js';
import { row as down } from '../ui/commands/down.js';
import { row as skill } from '../install/commands/skill.js';
import { row as update } from '../install/commands/update.js';
import { row as usage } from '../pipeline/commands/usage.js';
import { row as backlog } from '../pipeline/commands/backlog.js';
import { row as knowledge } from '../pipeline/commands/knowledge.js';
import { row as data } from '../pipeline/commands/data.js';
import { row as render } from '../pipeline/commands/render.js';
import { row as mergeLanes } from '../pipeline/commands/merge-lanes.js';
import { row as assertClean } from '../pipeline/commands/assert-clean.js';
import { row as project } from '../pipeline/commands/project.js';
import { row as migrateStepcast } from '../pipeline/commands/migrate-stepcast.js';

/**
 * Перечень строк встроенных команд CLI (`plugin-tree`, design.md изменения
 * `cli-commands-as-rows`, Решение 2, Решение 8): список модулей, тем же
 * порядком, каким сегодня идёт справка, — ни одного тела строки здесь нет
 * (помощник объявления — `src/kernel/cli/commandRow.ts`, отдельным модулем: если бы
 * он жил здесь, перечень и каждый из 25 модулей команд образовали бы цикл
 * импорта по значению). Точка входа (`src/parts/cli/main.ts`) подаёт его
 * `resolveConfig` (`COMMAND_ROW_IDS`) и `loadPlugins` (этот перечень) тем же
 * механизмом, каким `burnex up` подаёт `src/parts/ui/rows.ts`: дерево команд CLI =
 * перечень движка (`src/parts/rows.ts`) плюс этот перечень.
 *
 * Классификация (design.md, Решение 3, Решение 4): команда числится
 * доменной, если знает доменное понятие движка — документ пайплайна, прогон,
 * журнал, попытку, очередь улучшений, память репозитория, — и тогда её
 * строка объявляет `inject: PIPELINE_SERVICES` (`src/kernel/cli/commandRow.ts`),
 * снимаясь каскадом вместе со строкой `pipeline`. Восемнадцать доменных:
 * `run`, `resume`, `lint`, `status`, `logs`, `diff`, `decide`, `usage`,
 * `context`, `schema`, `gc`, `apply`, `propose`, `backlog`, `knowledge`,
 * `merge-lanes`, `assert-clean`, `project`. Восемь ядерных, без `inject`:
 * `plugins`, `package`, `config`, `up`, `down`, `update`, `widgets`, `data`, `render`, `init` — они читают
 * либо ничего доменного (`widgets`, `up`, `down` знают витрину, не пайплайн; `update` — способ установки движка),
 * либо обязаны работать именно тогда, когда состав сломан (`plugins`,
 * `config`, `package` — перечень пакетов нужен как раз для того, чтобы увидеть
 * пакет, сломавший работу). `data`, `render`, `down`, `init`, `update` и `migrate-stepcast` среди ядерных дополнительно независимы
 * от конфигурации (Решение 4, Решение 5) — граница проводится по порядку
 * исполнения, а не по домену: они исполняются раньше, чем состав существует,
 * и потребителем того, чего ещё нет, быть не могут.
 */
export const COMMAND_ROWS: readonly CommandRow[] = [
  run,
  resume,
  diff,
  decide,
  propose,
  widgets,
  apply,
  lint,
  status,
  logs,
  config,
  schema,
  plugins,
  packageRow,
  gc,
  init,
  context,
  up,
  down,
  update,
  skill,
  usage,
  backlog,
  knowledge,
  data,
  render,
  mergeLanes,
  assertClean,
  project,
  migrateStepcast,
];

/** Id строк команд — то, чем `parts/pipeline/config/resolve.ts` заводит семя дерева наравне с `BUILTIN_ROW_IDS`. */
export const COMMAND_ROW_IDS: readonly string[] = COMMAND_ROWS.map((row) => row.id);
