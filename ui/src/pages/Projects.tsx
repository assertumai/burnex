import { useCallback, useEffect, useState, type JSX } from 'react';

import { fetchProjects, pickProject, removeProject, type ProjectsOverview, type ProjectView } from '../api';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  EmptyState,
  PageHeader,
} from '@burnex/ui';
import './projects.css';

/**
 * Экран «Projects»: реестр проектов, которые пользователь добавил сам.
 * Остальные экраны витрины показывают только их. Пока реестр не заведён,
 * витрина показывает все проекты с прогонами — об этом говорит плашка.
 */

const PAGE_TITLE = 'Projects';
const PAGE_DESCRIPTION = 'Projects you added. Every other screen shows only these.';

function ProjectRow({
  project,
  busy,
  onRemove,
}: {
  readonly project: ProjectView;
  readonly busy: boolean;
  readonly onRemove: () => void;
}): JSX.Element {
  return (
    <tr>
      <td className="mono projects-path">
        {project.path}
        {project.exists ? null : (
          <>
            {' '}
            <Badge variant="destructive">missing</Badge>
          </>
        )}
      </td>
      <td className="mono small dim">{project.key}</td>
      <td className="small">{project.runs}</td>
      <td className="mono small dim">{project.latestRun ?? '—'}</td>
      <td className="projects-action">
        <Button variant="outline" size="sm" disabled={busy} onClick={onRemove}>
          Remove
        </Button>
      </td>
    </tr>
  );
}

function ProjectTable({
  projects,
  busy,
  onRemove,
}: {
  readonly projects: readonly ProjectView[];
  readonly busy: boolean;
  readonly onRemove: (project: ProjectView) => void;
}): JSX.Element {
  return (
    <table className="projects-table">
      <thead>
        <tr>
          <th>Path</th>
          <th>Key</th>
          <th>Runs</th>
          <th>Latest run</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {projects.map((project) => (
          <ProjectRow key={project.key} project={project} busy={busy} onRemove={() => onRemove(project)} />
        ))}
      </tbody>
    </table>
  );
}

export function Projects(): JSX.Element {
  const [overview, setOverview] = useState<ProjectsOverview | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const apply = useCallback((request: Promise<ProjectsOverview>): void => {
    setBusy(true);
    request
      .then((data) => {
        setOverview(data);
        setError(undefined);
      })
      .catch((failure: Error) => setError(failure.message))
      .finally(() => setBusy(false));
  }, []);

  useEffect(() => apply(fetchProjects()), [apply]);

  // Диалог выбора папки открывает демон на этой же машине: странице браузер
  // пути выбранной папки не отдаёт.
  const actions = (
    <Button disabled={busy} onClick={() => apply(pickProject())}>
      Add project
    </Button>
  );

  return (
    <>
      <PageHeader title={PAGE_TITLE} description={PAGE_DESCRIPTION} actions={actions} />
      {error !== undefined ? (
        <Alert variant="destructive">
          <AlertTitle>Projects request failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {overview === undefined ? (
        error === undefined ? <EmptyState title="Loading…" /> : null
      ) : (
        <>
          {overview.registered ? null : (
            <Alert>
              <AlertTitle>No projects added yet</AlertTitle>
              <AlertDescription>
                Until you add the first project, the dashboard shows every project that has runs. After that it shows
                only the added ones.
              </AlertDescription>
            </Alert>
          )}

          {overview.projects.length > 0 ? (
            <ProjectTable
              projects={overview.projects}
              busy={busy}
              onRemove={(project) => apply(removeProject(project.key))}
            />
          ) : overview.registered ? (
            <EmptyState title="No projects" description="Add a project to see its pipelines, runs and settings." />
          ) : null}
        </>
      )}
    </>
  );
}
