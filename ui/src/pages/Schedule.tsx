import { useEffect, useState, type JSX } from 'react';

import {
  fetchSchedule,
  type ProjectScheduleView,
  type ScheduleEntryView,
  type SchedulePipelineError,
  type ScheduleOverview,
  type TriggerServiceView,
} from '../api';
import { fmtTime } from '../format';
import { TargetLink } from '../routeLink';
import { RUN_TARGET } from '../screens/run';
import { Alert, AlertDescription, AlertTitle, Badge, EmptyState, PageHeader } from '@stepcast/ui';
import './schedule.css';

/**
 * Экран «Schedule» (`ui-schedule-view`): какие пайплайны стоят на расписании,
 * когда ближайший момент и когда пайплайн последний раз запускался по записи.
 * Только просмотр — расписание правится в документе пайплайна, поэтому на
 * странице нет ни поля, ни формы, ни кнопки правки.
 */

const PAGE_TITLE = 'Schedule';
const PAGE_DESCRIPTION = 'Pipelines declared on a schedule, their next moment and last scheduled run. Read-only.';

function ServiceBlock({ service }: { readonly service: TriggerServiceView }): JSX.Element {
  if (!service.present) {
    // Без флагов нарочно: показывать умолчания несуществующей секции значило
    // бы обещать поведение, которого нет (design.md, Решение 6).
    return (
      <Alert className="schedule-service">
        <AlertTitle>No trigger service</AlertTitle>
        <AlertDescription>Schedules are declared, but nothing fires them yet.</AlertDescription>
      </Alert>
    );
  }
  return (
    <section className="schedule-service">
      <h2 className="schedule-subhead">Trigger service</h2>
      <dl className="schedule-flags small">
        <dt>enabled</dt>
        <dd className="mono">{String(service.enabled)}</dd>
        <dt>keep_awake</dt>
        <dd className="mono">{String(service.keepAwake)}</dd>
        <dt>require_network</dt>
        <dd className="mono">{String(service.requireNetwork)}</dd>
        <dt>max_catchup_hours</dt>
        <dd className="mono">{service.maxCatchupHours}</dd>
      </dl>
    </section>
  );
}

function EntryRow({
  project,
  pipeline,
  entry,
  navigate,
}: {
  readonly project: ProjectScheduleView;
  readonly pipeline: string;
  readonly entry: ScheduleEntryView;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  const last = entry.lastRun;
  return (
    <tr>
      <td className="mono">{pipeline}</td>
      <td className="mono">{entry.cron ?? <span className="dim">—</span>}</td>
      <td className="mono">
        {entry.timezone === undefined ? <span className="dim">—</span> : entry.timezone}
        {entry.defaultTimezone ? (
          <>
            {' '}
            <Badge variant="outline" title="No timezone in the entry: the machine timezone applies">
              default
            </Badge>
          </>
        ) : null}
      </td>
      <td>
        {entry.error !== undefined ? (
          <span className="schedule-error">{entry.error}</span>
        ) : entry.next === undefined ? (
          <span className="dim">—</span>
        ) : (
          fmtTime(entry.next)
        )}
      </td>
      <td>
        {last === undefined ? (
          <span className="dim">never</span>
        ) : (
          <>
            <TargetLink
              target={RUN_TARGET}
              params={{ projectKey: project.projectKey, runId: last.runId }}
              navigate={navigate}
              className="mono"
            >
              {last.runId.slice(last.runId.lastIndexOf('-') + 1)}
            </TargetLink>
            <span className="dim small"> · for {fmtTime(last.moment)}</span>
            {last.status === undefined ? null : <span className="dim small"> · {last.status}</span>}
          </>
        )}
      </td>
      <td>{last === undefined ? <span className="dim">—</span> : last.catchup ? <Badge>catch-up</Badge> : 'no'}</td>
    </tr>
  );
}

const HEAD = ['Pipeline', 'Expression', 'Timezone', 'Next', 'Last scheduled run', 'Catch-up'] as const;

function FailureDetails({ failure }: { readonly failure: Partial<SchedulePipelineError> }): JSX.Element {
  const { errorFile, errorAt, errorHint } = failure;
  return (
    <>
      {errorFile === undefined && errorAt === undefined ? null : (
        <AlertDescription>
          where: {errorFile === undefined ? null : <span className="mono">{errorFile}</span>}
          {errorFile === undefined || errorAt === undefined ? null : ' · '}
          {errorAt === undefined ? null : <span className="mono">{errorAt}</span>}
        </AlertDescription>
      )}
      {errorHint === undefined ? null : <AlertDescription>{errorHint}</AlertDescription>}
    </>
  );
}

function ProjectSection({
  project,
  navigate,
}: {
  readonly project: ProjectScheduleView;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  return (
    <section className="schedule-project">
      <h2 className="project">{project.projectPath}</h2>

      {project.error !== undefined ? (
        <Alert variant="destructive">
          <AlertTitle>Project configuration cannot be read</AlertTitle>
          <AlertDescription>{project.error}</AlertDescription>
          <FailureDetails failure={project} />
        </Alert>
      ) : (
        <>
          {project.pipelines.length === 0 ? (
            <p className="dim small">No pipeline in this project declares a schedule.</p>
          ) : (
            <table className="schedule-table">
              <thead>
                <tr>
                  {HEAD.map((column) => (
                    <th key={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {project.pipelines.flatMap((pipeline) =>
                  pipeline.entries.map((entry) => (
                    <EntryRow
                      key={`${pipeline.pipeline}:${entry.index}`}
                      project={project}
                      pipeline={pipeline.pipeline}
                      entry={entry}
                      navigate={navigate}
                    />
                  )),
                )}
              </tbody>
            </table>
          )}

          {project.pipelineErrors.map((failure) => (
            <Alert key={failure.pipeline} variant="destructive" className="schedule-pipeline-error">
              <AlertTitle>
                <span className="mono">{failure.pipeline}</span> could not be read
              </AlertTitle>
              <AlertDescription>{failure.error}</AlertDescription>
              <FailureDetails failure={failure} />
            </Alert>
          ))}
        </>
      )}
    </section>
  );
}

/** Разметка по готовому ответу — отдельно от загрузки, чтобы проверяться статическим рендером. */
export function ScheduleList({
  overview,
  navigate = () => undefined,
}: {
  readonly overview: ScheduleOverview;
  readonly navigate?: (href: string) => void;
}): JSX.Element {
  return (
    <>
      <ServiceBlock service={overview.service} />
      {overview.projects.length === 0 ? (
        <EmptyState
          title="No projects"
          description="The daemon lists schedules of the projects whose runs it can see."
        />
      ) : (
        overview.projects.map((project) => (
          <ProjectSection key={project.projectKey} project={project} navigate={navigate} />
        ))
      )}
    </>
  );
}

export function Schedule({ navigate }: { readonly navigate: (href: string) => void }): JSX.Element {
  const [overview, setOverview] = useState<ScheduleOverview | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    fetchSchedule()
      .then((data) => {
        setOverview(data);
        setError(undefined);
      })
      .catch((failure: Error) => setError(failure.message));
  }, []);

  return (
    <>
      <PageHeader title={PAGE_TITLE} description={PAGE_DESCRIPTION} />
      {error !== undefined ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load schedule</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {overview === undefined ? (
        error === undefined ? <EmptyState title="Loading…" /> : null
      ) : (
        <ScheduleList overview={overview} navigate={navigate} />
      )}
    </>
  );
}
