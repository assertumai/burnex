import { useState, type JSX } from 'react';

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
} from '@burnex/ui';
import { lastPathSegment, unknownPathLabel } from '../../../src/parts/ui/runsView';
import {
  savePipelineAgent,
  type PipelineAgentSelection,
  type PipelineAgentTarget,
  type PipelineJobView,
  type PipelineStepView,
  type PipelineView,
  type Settings,
} from '../api';
import {
  AgentSelector,
  agentChoices,
  agentOriginLabel,
  effortOriginLabel,
  entryMarkLabel,
  modelOriginLabel,
} from './PipelineAgents';
// Заголовок проекта, путь, селектор и пометка записи — те же классы, что на «Pipelines».
import './pipelines.css';

/**
 * Вкладка Policy экрана «Agents» (`ui-agents-settings-merge`, design.md
 * Решение 4, 5): по каждому пайплайну — действующий `agent_policy` с файлом,
 * запись выбора агента на пайплайн и на каждый агентский шаг. Селектор,
 * варианты и подписи слоёв — те же, что на карточке шага «Pipelines»
 * (`./PipelineAgents.tsx`): здесь другая компоновка — все пайплайны и все
 * агентские шаги плоско, без графа и без командных шагов, — а не другая логика.
 */

/** Агентский шаг с работой, в чьей записи `step_agents` он живёт. */
export interface AgentStepRow {
  readonly job: PipelineJobView;
  readonly step: PipelineStepView;
}

/** Только агентские шаги — командным, скриптовым и плагинным агента не выбирают. */
export function agentSteps(pipeline: PipelineView): readonly AgentStepRow[] {
  return pipeline.jobs.flatMap((job) => job.steps.filter((step) => step.kind === 'agent').map((step) => ({ job, step })));
}

/** Пайплайны по проекту в порядке первого появления: ключ, путь и сами пайплайны. */
export function groupByProject(pipelines: readonly PipelineView[]): readonly {
  readonly projectKey: string;
  readonly projectPath: string;
  readonly pipelines: readonly PipelineView[];
}[] {
  const groups = new Map<string, { projectKey: string; projectPath: string; pipelines: PipelineView[] }>();
  for (const pipeline of pipelines) {
    const group = groups.get(pipeline.projectKey);
    if (group === undefined) {
      groups.set(pipeline.projectKey, { projectKey: pipeline.projectKey, projectPath: pipeline.projectPath, pipelines: [pipeline] });
    } else {
      group.pipelines.push(pipeline);
    }
  }
  return [...groups.values()];
}

function StepRow({
  pipeline,
  row,
  choices,
  busy,
  onApply,
}: {
  readonly pipeline: PipelineView;
  readonly row: AgentStepRow;
  readonly choices: ReturnType<typeof agentChoices> | undefined;
  readonly busy: boolean;
  readonly onApply: (target: PipelineAgentTarget, selection: PipelineAgentSelection | null) => void;
}): JSX.Element {
  const { job, step } = row;
  return (
    <div className="policy-step">
      <div className="step-head">
        <span className="job-name">
          {job.id}/{step.id}
        </span>
        {step.agent === undefined ? null : (
          <span className="kind">
            {step.agent}
            {step.model === undefined ? '' : ` · ${step.model}`}
            {step.effort === undefined ? '' : ` · effort ${step.effort}`}
          </span>
        )}
        {step.agentOrigin === undefined ? null : <span className="kind dim">{agentOriginLabel(step.agentOrigin)}</span>}
        {step.modelOrigin === undefined ? null : <span className="kind dim">{modelOriginLabel(step.modelOrigin)}</span>}
        {step.effortOrigin === undefined ? null : <span className="kind dim">{effortOriginLabel(step.effortOrigin)}</span>}
      </div>
      {step.agentEntry?.mark === undefined ? null : (
        <div className="ctx dim entry-mark">{entryMarkLabel(step.agentEntry.mark, pipeline.agentPolicy)}</div>
      )}
      {choices === undefined || pipeline.agentEntryName === undefined ? null : (
        <AgentSelector
          key={JSON.stringify(step.agentEntry ?? null)}
          target={{ pipeline: pipeline.agentEntryName, job: job.agentEntryJob, step: step.id }}
          entry={step.agentEntry}
          choices={choices}
          busy={busy}
          onApply={onApply}
        />
      )}
    </div>
  );
}

function PolicyCard({
  pipeline,
  choices,
  busy,
  onApply,
}: {
  readonly pipeline: PipelineView;
  readonly choices: ReturnType<typeof agentChoices> | undefined;
  readonly busy: boolean;
  readonly onApply: (target: PipelineAgentTarget, selection: PipelineAgentSelection | null) => void;
}): JSX.Element {
  if (pipeline.error !== undefined) {
    return (
      <Card className="policy-card">
        <CardHeader>
          <CardTitle>{pipeline.name}</CardTitle>
          <CardDescription className="mono">{pipeline.file}</CardDescription>
        </CardHeader>
        <CardContent>
          {/* Неразобранный пайплайн не выпадает молча: политики и шагов у него нет, причина названа. */}
          <div className="ctx dim">could not be parsed — no policy or steps to show: {pipeline.error}</div>
        </CardContent>
      </Card>
    );
  }

  const steps = agentSteps(pipeline);

  return (
    <Card className="policy-card">
      <CardHeader>
        <CardTitle>{pipeline.name}</CardTitle>
        <CardDescription className="mono">{pipeline.file}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="small dim">
          agent_policy <b>{pipeline.agentPolicy ?? 'force'}</b>
          {pipeline.agentPolicyFile === undefined ? '' : ` (${pipeline.agentPolicyFile})`}
        </div>
        {pipeline.agentEntry?.mark === undefined ? null : (
          <div className="ctx dim entry-mark">{entryMarkLabel(pipeline.agentEntry.mark, pipeline.agentPolicy)}</div>
        )}
        {/* Без `name` документ записей выбора не читает — как и на «Pipelines». */}
        {pipeline.agentEntryName !== undefined ? null : (
          <div className="ctx dim entry-mark">
            this pipeline has no name — add name: to the document to choose its agents here
          </div>
        )}
        {choices === undefined || pipeline.agentEntryName === undefined ? null : (
          <AgentSelector
            key={JSON.stringify(pipeline.agentEntry ?? null)}
            target={{ pipeline: pipeline.agentEntryName }}
            entry={pipeline.agentEntry}
            choices={choices}
            busy={busy}
            onApply={onApply}
          />
        )}
        {steps.length === 0 ? (
          <div className="ctx dim">no agent steps</div>
        ) : (
          steps.map((row) => (
            <StepRow
              key={`${row.job.id}/${row.step.id}`}
              pipeline={pipeline}
              row={row}
              choices={choices}
              busy={busy}
              onApply={onApply}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

export function AgentsPolicy({
  settings,
  pipelines,
  error,
  onPipelines,
}: {
  readonly settings: Settings;
  /** `undefined` — ответ `/api/pipelines` ещё не пришёл. */
  readonly pipelines: readonly PipelineView[] | undefined;
  readonly error: string | undefined;
  /** Ответ записи — заново раскрытые пайплайны: запись могла проиграть документу. */
  readonly onPipelines: (pipelines: readonly PipelineView[]) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  const apply = (target: PipelineAgentTarget, selection: PipelineAgentSelection | null): void => {
    setBusy(true);
    setSaveError(undefined);
    savePipelineAgent(target, selection)
      .then((data) => onPipelines(data.pipelines))
      .catch((failure: Error) => setSaveError(failure.message))
      .finally(() => setBusy(false));
  };

  if (error !== undefined) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load pipelines</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  if (pipelines === undefined) return <EmptyState title="Loading…" />;
  if (pipelines.length === 0) {
    return (
      <EmptyState
        title="No pipelines found"
        description="Agent selection applies to pipelines the daemon can see; there are none yet."
      />
    );
  }

  const choices = agentChoices(settings);

  return (
    <div className="agents-policy">
      <p className="small dim agent-note">
        <code>agent_policy</code> says whether the pipeline document or these entries win: under <code>force</code>{" "}
        an entry only fills what the document left unset, under <code>fallback</code> it overrides the document.
        Entries are written to <span className="mono">{settings.file}</span>; the same selectors sit on each step
        card of the Pipelines screen.
      </p>
      {saveError === undefined ? null : (
        <Alert variant="destructive">
          <AlertTitle>Could not save the selection</AlertTitle>
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}
      {groupByProject(pipelines).map((group) => (
        <section key={group.projectKey} className="pipelines-project">
          <h2 className="pipelines-project-title">{lastPathSegment(group.projectPath) || group.projectKey}</h2>
          <div className="pipelines-project-path" title={group.projectPath}>
            {group.projectPath === '' ? unknownPathLabel(group.projectKey) : group.projectPath}
          </div>
          {group.pipelines.map((pipeline) => (
            <PolicyCard
              key={`${pipeline.projectKey}/${pipeline.file}`}
              pipeline={pipeline}
              choices={choices}
              busy={busy}
              onApply={apply}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
