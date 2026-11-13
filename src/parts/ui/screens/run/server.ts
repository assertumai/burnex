import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

import { z } from 'zod';

import { resolveConfig } from '../../../pipeline/config/resolve.js';
import { runPaths, type RunPaths } from '../../../pipeline/run/journal/paths.js';
import { findStepDir, isRunAlive, listProjects } from '../../../pipeline/run/journal/reader.js';
import { DESIGN_FORMATS, isDesignFormat, mermaidBundlePath, parseDesignDocument, renderDesign } from '../../../pipeline/render/designDoc.js';
import { planResume, readSourceRun } from '../../../pipeline/run/resumePlan.js';
import { isBurnexError } from '../../../../kernel/errors.js';
import { INVALID, readBody, readNonNegativeInt, sendJson } from '../../daemon/http.js';
import { readJournalFile, readJournalJson } from '../../file.js';
import { parseRunAddress, snapshotOrRecord } from '../../runAddress.js';
import { isSafeSegment } from '../../routes.js';
import { readDiscussFeed } from '../../discussFeed.js';
import { readReviewFeed } from '../../reviewFeed.js';
import { readStepOutput } from '../../stepOutput.js';
import { screenRow, type ApiHandler } from '../registry.js';
import { declaration } from './declaration.js';

const handleSnapshot: ApiHandler = (req, res, env) => {
  const url = new URL(req.url ?? '/', 'http://internal');
  const parsed = parseRunAddress(url.searchParams.get('run'));
  if (parsed === undefined) {
    sendJson(res, 400, { error: 'Run address must look like <project>/<run>' });
    return;
  }

  const snapshot = snapshotOrRecord(env.runsRoot, parsed.key, parsed.runId);
  if (snapshot === undefined) {
    sendJson(res, 404, { error: `Run ${parsed.runId} not found` });
    return;
  }

  sendJson(res, 200, snapshot);
};

const handleFile: ApiHandler = (req, res, env) => {
  const url = new URL(req.url ?? '/', 'http://internal');
  const parsed = parseRunAddress(url.searchParams.get('run'));
  const requested = url.searchParams.get('path');

  if (parsed === undefined || requested === null) {
    sendJson(res, 400, { error: 'Parameters run=<project>/<run> and path are required' });
    return;
  }

  const paths = runPaths(env.runsRoot, parsed.key, parsed.runId);
  if (!existsSync(paths.dir)) {
    sendJson(res, 404, { error: `Run ${parsed.runId} not found` });
    return;
  }

  // Умолчание — хвост: без параметра просят лог, а у лога интересен конец.
  const side = url.searchParams.get('side') === 'head' ? 'head' : 'tail';

  try {
    sendJson(res, 200, readJournalFile(paths.dir, requested, side));
  } catch (error) {
    // Выход за каталог прогона — ошибка клиента, а не сбой сервера.
    const message = isBurnexError(error) ? error.message : 'File cannot be read';
    sendJson(res, isBurnexError(error) ? 400 : 404, { error: message });
  }
};

/**
 * Вывод шага по логическому адресу: прогон, работа, шаг, попытка, смещение.
 *
 * Путь файла клиент не подаёт вовсе (design.md, Решение 1) — разрешает его
 * `readStepOutput` через `findStepDir` на каждый запрос, поэтому проверять
 * выход за каталог прогона здесь нечего: обход невозможен по устройству.
 * Идентификаторы работы и шага всё равно проходят проверку сегмента, как и
 * везде в этом файле.
 */
const handleStepOutput: ApiHandler = (req, res, env) => {
  const url = new URL(req.url ?? '/', 'http://internal');
  const parsed = parseRunAddress(url.searchParams.get('run'));
  const jobId = url.searchParams.get('job');
  const stepId = url.searchParams.get('step');

  if (
    parsed === undefined ||
    jobId === null ||
    stepId === null ||
    !isSafeSegment(jobId) ||
    !isSafeSegment(stepId)
  ) {
    sendJson(res, 400, {
      error: 'Parameters run=<project>/<run>, job and step (single layout segments) are required',
    });
    return;
  }

  const paths = runPaths(env.runsRoot, parsed.key, parsed.runId);
  if (!existsSync(paths.dir)) {
    sendJson(res, 404, { error: `Run ${parsed.runId} not found` });
    return;
  }

  const attempt = readNonNegativeInt(url, 'attempt');
  if (attempt === INVALID || attempt === 0) {
    sendJson(res, 400, { error: 'attempt must be a positive integer' });
    return;
  }

  const pass = readNonNegativeInt(url, 'pass');
  if (pass === INVALID || pass === 0) {
    sendJson(res, 400, { error: 'pass must be a positive integer' });
    return;
  }

  // Вызов участника шага `review` — сегментом раскладки, как работа и шаг.
  const participant = url.searchParams.get('participant');
  if (participant !== null && !isSafeSegment(participant)) {
    sendJson(res, 400, { error: 'participant must be a single layout segment' });
    return;
  }
  const round = readNonNegativeInt(url, 'round');
  if (round === INVALID || round === 0 || (round !== undefined && participant === null)) {
    sendJson(res, 400, { error: 'round must be a positive integer and needs participant' });
    return;
  }
  // Ветка защитника — сегментом раскладки, только вместе с раундом.
  const thread = url.searchParams.get('thread');
  if (thread !== null && (!isSafeSegment(thread) || round === undefined)) {
    sendJson(res, 400, { error: 'thread must be a single layout segment and needs participant and round' });
    return;
  }

  const stdoutOffset = readNonNegativeInt(url, 'stdoutOffset');
  const stderrOffset = readNonNegativeInt(url, 'stderrOffset');
  if (stdoutOffset === INVALID || stderrOffset === INVALID) {
    sendJson(res, 400, { error: 'stdoutOffset and stderrOffset must be non-negative numbers' });
    return;
  }

  try {
    sendJson(
      res,
      200,
      readStepOutput(paths, jobId, stepId, {
        ...(attempt === undefined ? {} : { attempt }),
        ...(pass === undefined ? {} : { pass }),
        ...(participant === null ? {} : { participant }),
        ...(round === undefined ? {} : { round }),
        ...(thread === null ? {} : { thread }),
        ...(stdoutOffset === undefined ? {} : { stdoutOffset }),
        ...(stderrOffset === undefined ? {} : { stderrOffset }),
      }),
    );
  } catch (error) {
    // Чтение с диска гоняется с удалением прогона и с ротацией файлов: между
    // проверкой существования и чтением каталог шага может исчезнуть. Опрос
    // раз в секунду на каждое раскрытое окно делает эту гонку рядовой, а
    // необработанное исключение в слушателе запроса роняет весь демон —
    // отвечать надо одному запросу, как это делает `handleFile`.
    const message = isBurnexError(error) ? error.message : 'Step output cannot be read';
    sendJson(res, isBurnexError(error) ? 400 : 404, { error: message });
  }
};

interface StepAddress {
  readonly url: URL;
  readonly paths: RunPaths;
  readonly jobId: string;
  readonly stepId: string;
  readonly query: { readonly pass?: number };
}

/**
 * Адрес шага прогона из запроса (`run`, `job`, `step`, `pass`) — общий для
 * лент шагов и рендера документа. Неверный адрес получает ответ здесь же,
 * и тогда возвращается `undefined`.
 */
function stepAddress(req: IncomingMessage, res: ServerResponse, runsRoot: string): StepAddress | undefined {
  const url = new URL(req.url ?? '/', 'http://internal');
  const parsed = parseRunAddress(url.searchParams.get('run'));
  const jobId = url.searchParams.get('job');
  const stepId = url.searchParams.get('step');
  if (parsed === undefined || jobId === null || stepId === null || !isSafeSegment(jobId) || !isSafeSegment(stepId)) {
    sendJson(res, 400, {
      error: 'Parameters run=<project>/<run>, job and step (single layout segments) are required',
    });
    return undefined;
  }

  const paths = runPaths(runsRoot, parsed.key, parsed.runId);
  if (!existsSync(paths.dir)) {
    sendJson(res, 404, { error: `Run ${parsed.runId} not found` });
    return undefined;
  }

  const pass = readNonNegativeInt(url, 'pass');
  if (pass === INVALID || pass === 0) {
    sendJson(res, 400, { error: 'pass must be a positive integer' });
    return undefined;
  }
  return { url, paths, jobId, stepId, query: pass === undefined ? {} : { pass } };
}

/**
 * Лента шага с несколькими агентами — `review` (`review-defend`, design.md,
 * решение 8) или `discuss` (`render-design`, решение 7): модель, собранная
 * из журнала шага. Витрина опрашивает её, пока `done` не настал, — тем же
 * приёмом, что вывод шага.
 */
function feedHandler(what: string, read: (address: StepAddress) => unknown): ApiHandler {
  return (req, res, env) => {
    const address = stepAddress(req, res, env.runsRoot);
    if (address === undefined) return;
    try {
      const feed = read(address);
      if (feed === undefined) {
        sendJson(res, 404, { error: `Step ${address.jobId}/${address.stepId} has no ${what} record` });
        return;
      }
      sendJson(res, 200, feed);
    } catch (error) {
      // Та же гонка с удалением прогона, что у `handleStepOutput`.
      const message = isBurnexError(error) ? error.message : `The ${what} feed cannot be read`;
      sendJson(res, isBurnexError(error) ? 400 : 404, { error: message });
    }
  };
}

const handleReviewFeed = feedHandler('review', ({ paths, jobId, stepId, query }) => readReviewFeed(paths, jobId, stepId, query));
const handleDiscussFeed = feedHandler('discuss', ({ paths, jobId, stepId, query }) => readDiscussFeed(paths, jobId, stepId, query));

/**
 * `GET /api/design-render`: итог шага в офлайн-HTML или OpenSpec `design.md`
 * тем же рендером, что у `burnex render design` (`render-design`,
 * design.md, решение 7). Ответ — вложение для скачивания.
 */
const handleDesignRender: ApiHandler = (req, res, env) => {
  const address = stepAddress(req, res, env.runsRoot);
  if (address === undefined) return;
  const format = address.url.searchParams.get('format') ?? '';
  if (!isDesignFormat(format)) {
    sendJson(res, 400, { error: `format must be one of: ${DESIGN_FORMATS.join(', ')}` });
    return;
  }
  const dir = findStepDir(address.paths, address.jobId, address.stepId, undefined, undefined, address.query.pass);
  const output = dir === undefined ? undefined : readJournalJson(join(dir, 'output.json'));
  if (output === undefined) {
    sendJson(res, 404, { error: `Step ${address.jobId}/${address.stepId} has no output` });
    return;
  }
  let text: string;
  try {
    text = renderDesign(parseDesignDocument(output), format);
  } catch (error) {
    if (!isBurnexError(error)) throw error;
    const at = error.at === undefined ? '' : ` (${error.at})`;
    sendJson(res, 422, { error: `${error.message}${at}` });
    return;
  }
  const filename = `${address.jobId}-${address.stepId}${format === 'html' ? '.html' : '.design.md'}`;
  res.writeHead(200, {
    'content-type': format === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
  });
  res.end(text);
};

const ResumeBodySchema = z.object({ run: z.string().min(1), from: z.string().min(1) }).strict();

/**
 * `POST /api/run/resume`: возобновление с выбранной работы. Демон проверяет
 * запрос до порождения — отказ должен оказаться на кнопке, а `202` приходит
 * раньше исполнения, — но файлов прогона не пишет: новый прогон с
 * `resumed_from` создаёт порождённый `burnex resume`, который перепроверит
 * запрос по свежему состоянию.
 */
const handleResume: ApiHandler = async (req, res, env) => {
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

  const parsed = ResumeBodySchema.safeParse(raw);
  if (!parsed.success) {
    sendJson(res, 400, { error: 'Request body does not match the format: run and from' });
    return;
  }

  const address = parseRunAddress(parsed.data.run);
  if (address === undefined) {
    sendJson(res, 400, { error: 'run must look like <project>/<run>' });
    return;
  }

  const paths = runPaths(env.runsRoot, address.key, address.runId);
  if (!existsSync(paths.dir)) {
    sendJson(res, 404, { error: `Run ${address.runId} not found` });
    return;
  }

  if (isRunAlive(paths)) {
    sendJson(res, 409, { error: 'The run is in progress: wait for it to finish before resuming' });
    return;
  }

  const project = listProjects(env.runsRoot).find((entry) => entry.key === address.key);
  if (project?.path === undefined) {
    sendJson(res, 400, { error: `Project ${address.key} is unknown to the projects.json index` });
    return;
  }

  try {
    planResume({
      cwd: project.path,
      config: resolveConfig({ cwd: project.path }).config,
      source: readSourceRun(paths),
      from: parsed.data.from,
    });
  } catch (error) {
    sendJson(res, 400, { error: isBurnexError(error) ? error.message : 'The run cannot be resumed from this job' });
    return;
  }

  env.launchResume({ cwd: project.path, run: address.runId, from: parsed.data.from });
  sendJson(res, 202, { ok: true });
};

/**
 * `GET /api/vendor/mermaid.js`: бандл Mermaid, поставляемый пакетом
 * (`dist/vendor/`, `render-design`, design.md, решение 8). Витрина — одна
 * страница, и встраивать в неё 5 МБ ради диаграмм шага `discuss` дорого:
 * она подгружает бандл отсюда, только когда показывает диаграмму.
 */
const handleMermaidBundle: ApiHandler = (_req, res) => {
  let text: string;
  try {
    text = readFileSync(mermaidBundlePath(), 'utf8');
  } catch {
    sendJson(res, 404, { error: 'The Mermaid bundle is not part of this build — rebuild burnex' });
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // Бандл меняется только с релизом, а релиз перезапускает демон.
    'cache-control': 'private, max-age=3600',
  });
  res.end(text);
};

export const row = screenRow(declaration.id, ['screens', 'api'], (ctx) => {
  ctx.api.register('POST', '/api/run/resume', handleResume);
  ctx.screens.register(declaration);
  ctx.api.register('GET', '/api/run', handleSnapshot);
  ctx.api.register('GET', '/api/file', handleFile);
  ctx.api.register('GET', '/api/step-output', handleStepOutput);
  ctx.api.register('GET', '/api/review-feed', handleReviewFeed);
  ctx.api.register('GET', '/api/discuss-feed', handleDiscussFeed);
  ctx.api.register('GET', '/api/design-render', handleDesignRender);
  ctx.api.register('GET', '/api/vendor/mermaid.js', handleMermaidBundle);
});
