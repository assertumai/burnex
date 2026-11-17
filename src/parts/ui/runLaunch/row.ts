import { homedir } from 'node:os';
import { relative } from 'node:path';
import { z } from 'zod';

import { shownProjects } from '../projects.js';
import { packagedAddressName } from '../../../kernel/package-name.js';
import { packagedPipelineNames } from '../../pipeline/domain/package-schema.js';
import { listPipelineEntries } from '../../pipeline/domain/project/pipelines.js';
import { readBody, sendJson } from '../daemon/http.js';
import { screenRow, type ApiHandler } from '../screens/registry.js';
import { homeRoot } from '../../../kernel/dirs.js';

/**
 * Строка состава без экрана: `POST /api/run` (`ui-daemon`, design.md Решение
 * 13). Проект и файл пайплайна проверяются тем же обходом, каким их
 * перечисляет витрина (`listProjects`, `listPipelineFiles`) — маршрут не
 * принимает ничего сверх ключа проекта и имени файла, и запустить
 * произвольную команду через него нельзя.
 *
 * Необязательные `inputs` доезжают до `burnex run` ключами `--input`: так
 * доска запускает пайплайн для названного пункта очереди. Значения не
 * исполняются оболочкой — дочерний процесс порождается списком argv, — но
 * форма их всё равно проверена: имя входа и одна строка значения.
 *
 * `pipeline` формы `burnex:<имя>` — пайплайн поставки (`ui-daemon`, «Запуск
 * прогона принимает пайплайн поставки»): проверяется закрытым перечнем
 * `packagedPipelineNames()`, а не обходом файлов проекта — иначе кнопке
 * «Мигрировать» (`ui-widgets`) нечего было бы запускать.
 */

/**
 * Имя входа — то же, чем его объявляет документ пайплайна; значение
 * однострочно, как и всё, что доезжает ключом командной строки. Перевод
 * строки в значении отвергается здесь, а не рассекается дочерним процессом:
 * `--input` принимает одну пару `имя=значение`, и вторая строка стала бы
 * невесть чем.
 */
const InputsSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, 'input name: letters, digits, hyphen and underscore'),
  z.string().max(500).refine((value) => !/[\n\r]/.test(value), 'input value must fit on a single line'),
);

const EnvSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'env name: letters, digits and underscore'),
  z.string().max(500).refine((value) => !/[\n\r]/.test(value), 'env value must fit on a single line'),
);

const PostBodySchema = z
  .object({
    project: z.string().min(1),
    pipeline: z.string().min(1),
    /**
     * Входы пайплайна: доска передаёт сюда `item: <слаг>`. Ключ необязателен —
     * кнопка «Запустить» на экране пайплайнов шлёт запрос без него, и её
     * поведение этой возможностью не меняется.
     */
    inputs: InputsSchema.optional(),
    /**
     * Переопределения объявленного `env:` пайплайна на этот прогон. Допустимость
     * ключа проверяет дочерний `burnex run` — у него есть раскрытый
     * пайплайн; здесь — только форма: имя переменной и одна строка.
     */
    env: EnvSchema.optional(),
    /**
     * Shadow-режим: дочерний `burnex run` получает `--shadow`. Наличие
     * `external` у шагов проверяет он сам — здесь только форма значения.
     */
    shadow: z.boolean().optional(),
    /**
     * Агент на один прогон: дочерний `burnex run` получает `--agent`. Имя
     * бэкенда он проверяет сам; здесь — только форма, и ведущий дефис в неё не
     * входит: `--shadow` не должен стать значением, которое разбор флагов
     * прочтёт как следующий флаг.
     */
    agent: z
      .string({ error: 'agent must be a string' })
      .regex(/^[A-Za-z0-9_][A-Za-z0-9_-]*$/, 'agent: letters, digits, hyphen and underscore, no leading hyphen')
      .optional(),
    // `scheduled` опции `launchRun` здесь нарочно нет: происхождение «по
    // расписанию» объявляет сервис, а не форма, и `.strict()` отклоняет ключ.
  })
  .strict();

const handlePost: ApiHandler = async (req, res, env) => {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 413, { error: 'Request body is too large' });
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(body === '' ? '{}' : body) as unknown;
  } catch {
    sendJson(res, 400, { error: 'Request body is not valid JSON' });
    return;
  }

  const parsed = PostBodySchema.safeParse(raw);
  if (!parsed.success) {
    sendJson(res, 400, {
      error: `Request body does not match the format: ${parsed.error.issues[0]?.message ?? 'only project, pipeline, inputs, env, shadow and agent'}`,
    });
    return;
  }

  const project = shownProjects(env.runsRoot).find((entry) => entry.key === parsed.data.project);
  if (project?.path === undefined) {
    sendJson(res, 400, { error: `Project ${parsed.data.project} is unknown to the projects.json index` });
    return;
  }

  const packagedName = packagedAddressName(parsed.data.pipeline);
  if (packagedName !== undefined) {
    const name = packagedName;
    const known = packagedPipelineNames();
    if (!known.includes(name)) {
      sendJson(res, 400, { error: `Pipeline burnex:${name} is not shipped by the burnex package. The package ships: ${known.join(', ')}` });
      return;
    }
  } else {
    // Файлы проекта называются относительным путём, пайплайны пакетов — адресом
    // `<пакет>:<имя>`: путь пакета home лежит вне проекта, и запуск им отказал
    // бы как «путь наружу». Произвольный путь вне перечня по-прежнему отказывает.
    const files = listPipelineEntries(project.path, {
      globalConfigDir: homeRoot(env.home ?? homedir()),
    }).map((entry) => entry.address ?? relative(project.path as string, entry.path).replace(/\\/g, '/'));
    if (!files.includes(parsed.data.pipeline)) {
      sendJson(res, 400, {
        error: `Pipeline ${parsed.data.pipeline} not found among the files of project ${parsed.data.project}`,
      });
      return;
    }
  }

  env.launchRun({
    cwd: project.path,
    runsRoot: env.runsRoot,
    projectKey: parsed.data.project,
    pipeline: parsed.data.pipeline,
    ...(parsed.data.inputs === undefined ? {} : { inputs: parsed.data.inputs }),
    ...(parsed.data.env === undefined ? {} : { env: parsed.data.env }),
    ...(parsed.data.shadow === true ? { shadow: true } : {}),
    ...(parsed.data.agent === undefined ? {} : { agent: parsed.data.agent }),
  });
  // 202: подтверждение запуска, не обещание идентификатора прогона — он
  // появится в обзоре обычным тактом наблюдателя, когда дочерний процесс
  // напишет журнал (`ui-daemon`, Решение 13).
  sendJson(res, 202, { ok: true });
};

export const row = screenRow('ui-run-launch', ['api'], (ctx) => {
  ctx.api.register('POST', '/api/run', handlePost);
});
