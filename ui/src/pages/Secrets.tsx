import { useCallback, useEffect, useState, type JSX } from 'react';

import {
  fetchSecrets,
  type CredentialView,
  type ProjectSecretsView,
  type SecretsPipelineError,
  type SecretStatus,
  type SecretsOverview,
  type SecretView,
} from '../api';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  EmptyState,
  PageHeader,
  type BadgeVariant,
} from '@burnex/ui';
import './secrets.css';

/**
 * Экран «Secrets» (`ui-secrets-screen`): какие секреты ждут известные
 * пайплайны и бэкенды, каким провайдером и разрешаются ли они сейчас. Значений
 * здесь нет и быть не может: демон их не отдаёт, а тип ответа не имеет для них
 * поля. Экран читает `GET /api/secrets` при открытии и по кнопке — не по
 * потоку событий: каждое чтение — настоящая проба провайдеров.
 */

const PAGE_TITLE = 'Secrets';
const PAGE_DESCRIPTION =
  'Names, providers and whether each secret resolves right now. Values are never shown.';

export const STATUS_TITLE: Readonly<Record<SecretStatus, string>> = {
  resolved: 'resolved',
  'not-found': 'not found',
  'provider-unavailable': 'provider unavailable',
};

/** Нашёлся — успех; не нашёлся — отказ запуска; провайдер недоступен — отдельный тон. */
const STATUS_VARIANT: Readonly<Record<SecretStatus, BadgeVariant>> = {
  resolved: 'success',
  'not-found': 'destructive',
  'provider-unavailable': 'secondary',
};

function formatParams(params: Readonly<Record<string, unknown>>): string {
  return Object.entries(params)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
}

function StatusCell({ entry }: { readonly entry: SecretView | CredentialView }): JSX.Element {
  return (
    <>
      <td>
        <Badge variant={STATUS_VARIANT[entry.status]}>{STATUS_TITLE[entry.status]}</Badge>
      </td>
      <td className="secrets-reason">
        {entry.reason === undefined ? (
          <span className="dim">—</span>
        ) : (
          <>
            <span>{entry.reason}</span>
            {entry.reasonHint === undefined ? null : <span className="dim secrets-hint">{entry.reasonHint}</span>}
          </>
        )}
      </td>
    </>
  );
}

function SecretRow({ secret }: { readonly secret: SecretView }): JSX.Element {
  return (
    <tr>
      <td className="mono">
        {secret.name}
        {secret.unused ? (
          <>
            {' '}
            <Badge variant="outline">not used</Badge>
          </>
        ) : null}
      </td>
      <td className="mono">{secret.env}</td>
      <td className="mono">{secret.provider}</td>
      <td className="mono small">{formatParams(secret.params)}</td>
      <td className="small">
        {secret.usedBy.length === 0 ? (
          <span className="dim">—</span>
        ) : (
          <ul className="secrets-usage">
            {secret.usedBy.map((usage) => (
              <li key={usage.pipeline}>
                <span className="mono">{usage.pipeline}</span>
                <span className="dim"> · {usage.steps.join(', ')}</span>
              </li>
            ))}
          </ul>
        )}
      </td>
      <StatusCell entry={secret} />
    </tr>
  );
}

function CredentialRow({ credential }: { readonly credential: CredentialView }): JSX.Element {
  return (
    <tr>
      <td className="mono">
        {credential.at}
        {credential.inUse ? null : (
          <>
            {' '}
            <Badge variant="outline">backend not used</Badge>
          </>
        )}
      </td>
      <td className="mono">{credential.variable}</td>
      <td className="mono">{credential.provider}</td>
      <td className="mono small">{formatParams(credential.params)}</td>
      <td className="small mono">{credential.backend}</td>
      <StatusCell entry={credential} />
    </tr>
  );
}

const HEAD = ['Name', 'Env', 'Provider', 'Params', 'Used by', 'Status', 'Reason'] as const;
const CREDENTIAL_HEAD = ['Record', 'Env', 'Provider', 'Params', 'Backend', 'Status', 'Reason'] as const;

function Head({ columns }: { readonly columns: readonly string[] }): JSX.Element {
  return (
    <thead>
      <tr>
        {columns.map((column) => (
          <th key={column}>{column}</th>
        ))}
      </tr>
    </thead>
  );
}

type FailureFields = Pick<SecretsPipelineError, 'errorFile' | 'errorAt' | 'errorHint'>;

/**
 * Место и подсказка отказа — как на «Pipelines»: файл ошибки (работа может
 * прийти по `uses` из другого файла), путь внутри документа и совет.
 * Без них отказ называет беду, но не отвечает «где именно».
 */
function FailureDetails({ failure }: { readonly failure: FailureFields }): JSX.Element {
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

function ProjectSection({ project }: { readonly project: ProjectSecretsView }): JSX.Element {
  return (
    <section className="secrets-project">
      <h2 className="project">{project.projectPath}</h2>

      {project.error !== undefined ? (
        <Alert variant="destructive">
          <AlertTitle>Project configuration cannot be read</AlertTitle>
          <AlertDescription>{project.error}</AlertDescription>
          <FailureDetails failure={project} />
        </Alert>
      ) : (
        <>
          <p className="secrets-providers small">
            <span className="dim">Providers: </span>
            {project.providers.map((provider) => (
              <span key={provider.name} className="secrets-provider">
                <span className="mono">{provider.name}</span>
                <span className="dim"> ({provider.owner})</span>
              </span>
            ))}
          </p>

          {project.secrets.length === 0 ? (
            <p className="dim small">No pipeline in this project declares secrets.</p>
          ) : (
            <table className="secrets-table">
              <Head columns={HEAD} />
              <tbody>
                {project.secrets.map((secret) => (
                  <SecretRow key={`${secret.name}:${secret.provider}:${secret.env}:${formatParams(secret.params)}`} secret={secret} />
                ))}
              </tbody>
            </table>
          )}

          {project.credentials.length === 0 ? null : (
            <>
              <h3 className="secrets-subhead">Backend credentials</h3>
              <table className="secrets-table">
                <Head columns={CREDENTIAL_HEAD} />
                <tbody>
                  {project.credentials.map((credential) => (
                    <CredentialRow key={credential.at} credential={credential} />
                  ))}
                </tbody>
              </table>
            </>
          )}

          {project.pipelineErrors.map((failure) => (
            <Alert key={failure.pipeline} variant="destructive" className="secrets-pipeline-error">
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
export function SecretsList({ overview }: { readonly overview: SecretsOverview }): JSX.Element {
  if (overview.projects.length === 0) {
    return (
      <EmptyState
        title="No projects"
        description="The daemon lists secrets of the projects whose runs it can see."
      />
    );
  }
  return (
    <>
      {overview.projects.map((project) => (
        <ProjectSection key={project.projectKey} project={project} />
      ))}
    </>
  );
}

export function Secrets(): JSX.Element {
  const [overview, setOverview] = useState<SecretsOverview | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const load = useCallback((): void => {
    setLoading(true);
    // Пробы провайдеров ходят в связку ключей и сеть; ответ может идти
    // секундами, и индикатор загрузки честнее пустой таблицы.
    fetchSecrets()
      .then((data) => {
        setOverview(data);
        setError(undefined);
      })
      .catch((failure: Error) => setError(failure.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const actions = (
    <Button variant="outline" size="sm" disabled={loading} onClick={load}>
      {loading ? 'Checking…' : 'Check again'}
    </Button>
  );

  return (
    <>
      <PageHeader title={PAGE_TITLE} description={PAGE_DESCRIPTION} actions={actions} />
      {error !== undefined ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load secrets</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {overview === undefined ? (
        error === undefined ? <EmptyState title="Loading…" /> : null
      ) : (
        <div className={loading ? 'secrets-stale' : undefined} aria-busy={loading}>
          <SecretsList overview={overview} />
        </div>
      )}
    </>
  );
}
