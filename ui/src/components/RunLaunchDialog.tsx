import { useEffect, useState, type JSX } from 'react';

import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@stepcast/ui';
import { fetchPipelines, fetchSettings, launchRun, type BackendView, type PipelineView } from '../api';
import {
  DEFAULT_AGENT,
  agentChoices,
  agentImpact,
  buildLaunchBody,
  envRowsOf,
  initialInputs,
  initialPipeline,
  launchBlocker,
  projectsOf,
  runnableOf,
  submitLaunch,
  type LaunchDraft,
  type LaunchPayload,
} from '../runLaunch';
import { lastPathSegment } from '../../../src/parts/ui/runsView';
// Классы списка пайплайнов и поля формы общие с диалогами доски.
import '../pages/scrum.css';

/**
 * Диалог запуска прогона (`ui-run-launch-dialog`): один на «Scrum» («Start
 * work») и на «Runs» («New run»). Всё, что иначе случилось бы молча в дочернем
 * `stepcast run` уже после 202, форма ловит до отправки: необъявленный ключ
 * env, неготовый к shadow пайплайн, агент, которого пайплайн не меняет.
 */

/** Предвыбор из контекста вызова: «Scrum» знает проект и пункт, «Runs» — ничего. */
export interface LaunchPreselect {
  readonly projectKey?: string;
  /** Слаг и заголовок пункта доски. */
  readonly item?: { readonly slug: string; readonly title: string };
}

const AGENT_DEFAULT_VALUE = '__default__';

function draftFor(
  pipelines: readonly PipelineView[],
  preselect: LaunchPreselect,
  projectKey?: string,
): LaunchDraft {
  const projects = projectsOf(pipelines);
  const project = projectKey ?? preselect.projectKey ?? projects[0]?.key ?? '';
  const pipeline = initialPipeline(runnableOf(pipelines, project), preselect.item?.slug);
  return {
    project,
    pipeline: pipeline?.file ?? '',
    inputs: initialInputs(pipeline, preselect.item?.slug),
    envText: '',
    shadow: false,
    agent: DEFAULT_AGENT,
  };
}

export interface RunLaunchFormProps {
  readonly pipelines: readonly PipelineView[];
  readonly backends: readonly BackendView[];
  readonly preselect?: LaunchPreselect;
  readonly onClose: () => void;
  /** Отправка запроса; в тестах — заглушка. */
  readonly launch?: (payload: LaunchPayload) => Promise<unknown>;
}

/** Тело диалога без оболочки `Dialog`: оболочка рисуется порталом, а форму можно показать и проверить отдельно. */
export function RunLaunchForm({
  pipelines,
  backends,
  preselect = {},
  onClose,
  launch = launchRun,
}: RunLaunchFormProps): JSX.Element {
  const [draft, setDraft] = useState<LaunchDraft>(() => draftFor(pipelines, preselect));
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const projects = projectsOf(pipelines);
  const runnable = runnableOf(pipelines, draft.project);
  const broken = pipelines.filter((pipeline) => pipeline.projectKey === draft.project && pipeline.error !== undefined);
  const selected = runnable.find((pipeline) => pipeline.file === draft.pipeline);

  const rows = envRowsOf(draft, selected);
  const blocker = launchBlocker(draft, selected);
  const impact = selected === undefined ? undefined : agentImpact(selected);
  const choices = agentChoices(backends);

  const chooseProject = (project: string): void => {
    setError(undefined);
    setDraft(draftFor(pipelines, preselect, project));
  };
  const choosePipeline = (file: string): void => {
    const pipeline = runnable.find((entry) => entry.file === file);
    setError(undefined);
    // Env, входы и shadow принадлежат пайплайну: объявленные имена у другого
    // другие, и перенесённая строка стала бы ошибкой, о которой пользователь
    // не просил.
    setDraft((current) => ({
      ...current,
      pipeline: file,
      inputs: initialInputs(pipeline, preselect.item?.slug),
      envText: '',
      shadow: false,
    }));
  };

  const start = async (): Promise<void> => {
    if (selected === undefined || blocker !== undefined) return;
    setBusy(true);
    setError(undefined);
    const outcome = await submitLaunch(buildLaunchBody(draft, selected), launch);
    setBusy(false);
    if (outcome.ok) onClose();
    else setError(outcome.error);
  };

  if (projects.length === 0) {
    return (
      <>
        <EmptyState title="No pipelines" description="No pipeline files were found in the known projects." />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      {preselect.projectKey !== undefined ? null : (
        <Label className="scrum-field">
          <span>Project</span>
          <Select value={draft.project} onValueChange={chooseProject}>
            <SelectTrigger aria-label="Project">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {projects.map((project) => (
                <SelectItem key={project.key} value={project.key} title={project.path}>
                  {lastPathSegment(project.path)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Label>
      )}

      {runnable.length === 0 ? (
        <EmptyState title="No pipelines" description="No pipeline files were found in this project’s pipeline directory." />
      ) : (
        <ul className="scrum-pipelines">
          {runnable.map((pipeline) => (
            <li key={pipeline.file}>
              <label className="scrum-pipeline">
                <input
                  type="radio"
                  name="run-launch-pipeline"
                  value={pipeline.file}
                  checked={pipeline.file === draft.pipeline}
                  onChange={() => choosePipeline(pipeline.file)}
                />
                <span className="scrum-pipeline-body">
                  <span className="scrum-pipeline-name">{pipeline.name}</span>
                  <span className="small dim mono">{pipeline.file}</span>
                  <span className="small dim">
                    {pipeline.jobs.length} jobs
                    {preselect.item === undefined || pipeline.inputs.includes('item')
                      ? null
                      : // Честнее сказать заранее, чем показать прогон, взявший
                        // не тот пункт: пайплайн без входа отбирает очередной
                        // свободный сам.
                        ' · does not accept an item: picks the next free one itself'}
                  </span>
                </span>
              </label>
            </li>
          ))}
          {broken.map((pipeline) => (
            <li key={pipeline.file}>
              <span className="scrum-pipeline-body">
                <span className="scrum-pipeline-name dim">{pipeline.name}</span>
                <span className="small scrum-pipeline-error">{pipeline.error}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {selected === undefined ? null : (
        <>
          {selected.inputs.map((name) => (
            <Label key={name} className="scrum-field">
              <span>
                Input <span className="mono">{name}</span>
              </span>
              <Input
                value={draft.inputs[name] ?? ''}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, inputs: { ...current.inputs, [name]: event.target.value } }))
                }
              />
            </Label>
          ))}

          <Label className="scrum-field">
            <span>
              Env overrides{' '}
              <span className="small dim">
                one KEY=VALUE per line
                {selected.envNames.length === 0
                  ? ' · this pipeline declares no env'
                  : ` · declared: ${selected.envNames.join(', ')}`}
              </span>
            </span>
            <textarea
              className="sc-input"
              rows={3}
              aria-label="Env overrides"
              value={draft.envText}
              onChange={(event) => setDraft((current) => ({ ...current, envText: event.target.value }))}
            />
          </Label>
          {rows
            .filter((row) => row.error !== undefined)
            .map((row) => (
              <p key={row.line} className="small scrum-pipeline-error">
                Line {row.line + 1}: {row.error}
              </p>
            ))}

          <div className="scrum-field">
            <span>
              Shadow mode{' '}
              <Switch
                aria-label="Shadow mode"
                checked={draft.shadow && selected.shadow.ready}
                disabled={!selected.shadow.ready}
                onCheckedChange={(shadow) => setDraft((current) => ({ ...current, shadow }))}
              />
            </span>
            <span className="small dim">
              {selected.shadow.ready
                ? 'External actions of steps are recorded, not performed.'
                : `Not available: external is not declared for ${selected.shadow.steps.join(', ')}`}
            </span>
          </div>

          <div className="scrum-field">
            <span>Agent for this run</span>
            <Select
              value={draft.agent === DEFAULT_AGENT ? AGENT_DEFAULT_VALUE : draft.agent}
              onValueChange={(value) =>
                setDraft((current) => ({ ...current, agent: value === AGENT_DEFAULT_VALUE ? DEFAULT_AGENT : value }))
              }
            >
              <SelectTrigger aria-label="Agent">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AGENT_DEFAULT_VALUE}>Configured default</SelectItem>
                {choices.map((choice) => (
                  <SelectItem key={choice.name} value={choice.name} disabled={choice.disabled}>
                    {choice.name}
                    {choice.disabled ? ' (unavailable)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="small dim">
              {impact === undefined || impact.affected === 0
                ? 'The choice does not change this pipeline: its agent steps are named by the document or by your agent entries.'
                : `Applies to ${impact.affected} of ${impact.agentSteps} agent steps; steps whose agent is named by the document or by your agent entries keep theirs.`}
            </span>
          </div>
        </>
      )}

      {error === undefined ? null : (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={busy || blocker !== undefined} title={blocker} onClick={() => void start()}>
          Start
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Оболочка: пайплайны и бэкенды загружаются при открытии, а форма монтируется
 * заново на каждое открытие — выбор прошлого запуска не переносится.
 */
export function RunLaunchDialog({
  open,
  preselect,
  onClose,
}: {
  readonly open: boolean;
  readonly preselect?: LaunchPreselect;
  readonly onClose: () => void;
}): JSX.Element {
  const [data, setData] = useState<{ pipelines: readonly PipelineView[]; backends: readonly BackendView[] } | undefined>(
    undefined,
  );
  const [loadError, setLoadError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!open) {
      setData(undefined);
      return;
    }
    let alive = true;
    setLoadError(undefined);
    // Пайплайны нужны диалогу и меняются редко — разовый запрос при открытии.
    // Список бэкендов необязателен: без него поле агента просто пусто.
    Promise.all([fetchPipelines(), fetchSettings().catch(() => undefined)])
      .then(([overview, settings]) => {
        if (alive) setData({ pipelines: overview.pipelines, backends: settings?.backends ?? [] });
      })
      .catch((cause: Error) => {
        if (alive) setLoadError(cause.message);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{preselect?.item === undefined ? 'New run' : 'Start work'}</DialogTitle>
          <DialogDescription>
            {preselect?.item === undefined ? (
              'Pick a project and a pipeline, then set the inputs of this run.'
            ) : (
              <>
                Item <span className="mono">{preselect.item.slug}</span>: {preselect.item.title}
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {loadError === undefined ? null : (
          <Alert variant="destructive">
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        )}
        {data === undefined ? null : (
          <RunLaunchForm
            pipelines={data.pipelines}
            backends={data.backends}
            {...(preselect === undefined ? {} : { preselect })}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
