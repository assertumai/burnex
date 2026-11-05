import { useCallback, useEffect, useState, type JSX } from 'react';

import {
  fetchPackages,
  type PackageProblemView,
  type PackageResourceKind,
  type PackagesOverview,
  type PackageView,
} from '../api';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  type BadgeVariant,
} from '@burnex/ui';
import './packages.css';

/**
 * Экран «Packages» (`ui-packages-screen`): пакеты слоёв проекта и home, что
 * каждый приносит поимённо, действует ли он, а если нет или если отказал его
 * ресурс — почему. Только чтение: витрина в каталог пакета не пишет. Экран
 * читает `GET /api/packages` при открытии и по кнопке; демон пересобирает
 * сводку сам, так что повторный запрос видит новые пакеты без перезапуска.
 */

const PAGE_TITLE = 'Packages';
const PAGE_DESCRIPTION =
  'Packages of the project and home layers: what each one brings, whether it is in effect, and which of its resources failed.';

/** Порядок видов — порядок `ResourceKind` в сводке. */
const KIND_ORDER: readonly PackageResourceKind[] = [
  'pipelines',
  'steps',
  'scripts',
  'plugins',
  'widgets',
  'dashboards',
  'routes',
];

const LAYERS: readonly { readonly layer: 'project' | 'home'; readonly title: string }[] = [
  { layer: 'project', title: 'Project' },
  { layer: 'home', title: 'Home' },
];

const STATUS_VARIANT: Readonly<Record<PackageView['status'], BadgeVariant>> = {
  ok: 'success',
  broken: 'destructive',
  shadowed: 'secondary',
};

const STATUS_TITLE: Readonly<Record<PackageView['status'], string>> = {
  ok: 'in effect',
  broken: 'broken',
  shadowed: 'shadowed',
};

/** Пайплайн пакета вызывается адресом `<пакет>:<имя>`; прочие виды — собственным именем. */
function resourceLabel(pack: PackageView, kind: PackageResourceKind, name: string): string {
  return kind === 'pipelines' ? `${pack.name}:${name}` : name;
}

function problemsOf(problems: readonly PackageProblemView[], pack: PackageView): readonly PackageProblemView[] {
  return problems.filter((problem) => problem.layer === pack.layer && problem.packages.includes(pack.name));
}

function describeProblem(problem: PackageProblemView, pack: PackageView): string {
  const target = problem.id === undefined ? problem.kind : `${problem.kind} ${problem.id}`;
  const others = problem.packages.filter((name) => name !== pack.name);
  return others.length === 0 ? target : `${target} (also provided by ${others.join(', ')})`;
}

function Contents({ pack }: { readonly pack: PackageView }): JSX.Element {
  const kinds = KIND_ORDER.filter((kind) => (pack.contents[kind]?.length ?? 0) > 0);
  const inEffect = pack.status === 'ok';
  if (kinds.length === 0) return <p className="dim packages-contents-empty">No resources.</p>;
  return (
    <div className={inEffect ? 'packages-contents' : 'packages-contents packages-contents-muted'}>
      {inEffect ? null : <p className="dim packages-contents-note">Not used in lookup</p>}
      <dl>
        {kinds.map((kind) => (
          <div key={kind} className="packages-contents-row">
            <dt>{kind}</dt>
            <dd className="mono">
              {(pack.contents[kind] ?? []).map((name) => resourceLabel(pack, kind, name)).join(', ')}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function UnmetNeeds({ pack }: { readonly pack: PackageView }): JSX.Element | null {
  const entries = Object.entries(pack.unmetNeeds ?? {});
  if (entries.length === 0) return null;
  return (
    <p className="packages-needs">
      <span className="dim">needs:</span>{' '}
      {entries.map(([kind, names]) => `${kind} ${names.join(', ')}`).join('; ')}
    </p>
  );
}

function PackageCard({
  pack,
  problems,
}: {
  readonly pack: PackageView;
  readonly problems: readonly PackageProblemView[];
}): JSX.Element {
  return (
    <Card className="packages-card">
      <CardHeader>
        <CardTitle>
          <span className="mono">{pack.name}</span>
          {pack.version === undefined ? null : <span className="dim packages-version"> {pack.version}</span>}{' '}
          <Badge variant={STATUS_VARIANT[pack.status]}>{STATUS_TITLE[pack.status]}</Badge>
        </CardTitle>
        {pack.description === undefined || pack.description === '' ? null : (
          <CardDescription>{pack.description}</CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <p className="mono dim packages-dir">{pack.dir}</p>
        {pack.status === 'broken' && pack.reason !== undefined ? (
          <Alert variant="destructive" className="packages-reason">
            <AlertDescription>{pack.reason}</AlertDescription>
          </Alert>
        ) : null}
        {pack.status === 'shadowed' ? (
          <p className="packages-reason dim">Shadowed by a {pack.shadowedBy ?? 'project'} package of the same name.</p>
        ) : null}
        <Contents pack={pack} />
        <UnmetNeeds pack={pack} />
        {problems.length === 0 ? null : (
          <ul className="packages-problems">
            {problems.map((problem) => (
              <li key={`${problem.kind}:${problem.id ?? ''}:${problem.packages.join('+')}`}>
                <Badge variant="destructive">{describeProblem(problem, pack)}</Badge>{' '}
                <span className="packages-problem-message">{problem.message}</span>
                {problem.file === undefined ? null : <span className="mono dim packages-hint"> {problem.file}</span>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Разметка по готовому ответу — отдельно от чтения, чтобы проверять её без сети. */
export function PackagesList({ overview }: { readonly overview: PackagesOverview }): JSX.Element {
  return (
    <>
      {overview.pluginsError === undefined ? null : (
        <Alert variant="destructive" className="packages-plugins-error">
          <AlertTitle>Plugin tree was not built</AlertTitle>
          <AlertDescription>
            Plugin failures of packages are not shown: {overview.pluginsError}
          </AlertDescription>
        </Alert>
      )}
      {LAYERS.map(({ layer, title }) => {
        const packs = overview.packages.filter((pack) => pack.layer === layer);
        const dir = overview.layers?.[layer];
        return (
          <section key={layer} className="packages-layer" aria-label={title}>
            <h2 className="packages-layer-title">{title}</h2>
            {packs.length === 0 ? (
              <EmptyState
                title="No packages"
                description={dir === undefined ? 'The layer has no packages directory.' : `Put a package directory into ${dir}.`}
              />
            ) : (
              packs.map((pack) => (
                <PackageCard key={`${pack.layer}:${pack.name}`} pack={pack} problems={problemsOf(overview.problems, pack)} />
              ))
            )}
          </section>
        );
      })}
    </>
  );
}

export function Packages(): JSX.Element {
  const [overview, setOverview] = useState<PackagesOverview | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const load = useCallback((): void => {
    setLoading(true);
    fetchPackages()
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
      {loading ? 'Loading…' : 'Refresh'}
    </Button>
  );

  return (
    <>
      <PageHeader title={PAGE_TITLE} description={PAGE_DESCRIPTION} actions={actions} />
      {error !== undefined ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load packages</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {overview === undefined ? (
        error === undefined ? <EmptyState title="Loading…" /> : null
      ) : (
        <div className={loading ? 'packages-stale' : undefined} aria-busy={loading}>
          <PackagesList overview={overview} />
        </div>
      )}
    </>
  );
}
