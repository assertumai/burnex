import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react';

import {
  fetchModels,
  fetchSystem,
  fetchSystemLog,
  fetchSystemUpdate,
  setSystemAutostart,
  startSystemUpdate,
  type SystemActionKind,
  type SystemAutostart,
  type SystemBackend,
  type SystemEngine,
  type SystemOverview,
  type SystemProbe,
  type SystemRefusal,
  type SystemUpdate,
} from '../api';
import { fmtTime } from '../format';
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
  Switch,
} from '@burnex/ui';
import './system.css';

/**
 * Экран «System» (`ui-system-health`): версия и способ установки, демон,
 * автозапуск, бэкенды и модели без цены. Открытие экрана — чтение без сети и
 * без новых проб; сеть только по кнопке «Check for updates», пробы моделей
 * только по кнопке «Check».
 */

const PAGE_TITLE = 'System';
const PAGE_DESCRIPTION = 'Version and install method, the daemon, autostart, backends and models without a price.';

/** Сколько ждать возвращения демона после действия, прежде чем показать журнал. */
export const RESTART_WAIT_MS = 60_000;
const POLL_MS = 1_000;

const AUTH_NOTE =
  'Authentication is not probed: a call to the model costs money and quota. A refusal shows up after the first run that hit it.';

/** Что набрать в терминале, если действие с экрана не довело дело до конца. */
export const TERMINAL_COMMAND: Readonly<Record<SystemActionKind, string>> = {
  update: 'burnex update',
  autostart: 'burnex up --install',
};

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }): JSX.Element {
  return (
    <>
      <dt className="dim">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

export function EngineCard({ engine }: { readonly engine: SystemEngine }): JSX.Element {
  return (
    <Card className="system-card">
      <CardHeader>
        <CardTitle>Engine</CardTitle>
        <CardDescription>What is running and how it was installed</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="system-facts">
          <Row label="Version">
            <span className="mono">{engine.version ?? 'unknown'}</span>
          </Row>
          <Row label="Install method">
            {engine.method === undefined ? (
              <span className="dim">unknown</span>
            ) : (
              <>
                <span className="mono">{engine.method}</span>{' '}
                <span className="dim">
                  {engine.source === 'manifest' ? '(install passport)' : '(inferred from the engine path)'}
                </span>
              </>
            )}
          </Row>
          {engine.managed === undefined ? null : (
            <>
              <Row label="Ref">
                <span className="mono">{engine.managed.ref}</span>{' '}
                <span className="dim">version {engine.managed.version}</span>
              </Row>
              <Row label="Current release">
                {engine.managed.release === undefined ? (
                  <span className="dim">current does not point to a release</span>
                ) : (
                  <span className="mono">{engine.managed.release}</span>
                )}
              </Row>
              {engine.managed.installedAt === undefined ? null : (
                <Row label="Installed">{fmtTime(engine.managed.installedAt)}</Row>
              )}
            </>
          )}
          {engine.checkoutDir === undefined ? null : (
            <Row label="Checkout">
              <span className="mono">{engine.checkoutDir}</span>
            </Row>
          )}
          {engine.npmPackage === undefined ? null : (
            <Row label="Package">
              <span className="mono">{engine.npmPackage}</span>
            </Row>
          )}
          <Row label="Root">
            <span className="mono small">{engine.root}</span>
          </Row>
        </dl>
        {engine.error === undefined ? null : (
          <Alert variant="destructive" className="system-note">
            <AlertTitle>Install method is not known</AlertTitle>
            <AlertDescription>{engine.error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

export function DaemonCard({ daemon }: { readonly daemon: SystemOverview['daemon'] }): JSX.Element {
  return (
    <Card className="system-card">
      <CardHeader>
        <CardTitle>Daemon</CardTitle>
        <CardDescription>This process, as it knows itself</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="system-facts">
          <Row label="PID">
            <span className="mono">{daemon.pid}</span>{' '}
            {daemon.underLaunchd ? <Badge variant="outline">started by the launchd agent</Badge> : null}
          </Row>
          <Row label="Up since">{fmtTime(daemon.startedAt)}</Row>
          <Row label="Port">
            <span className="mono">{daemon.port}</span>
          </Row>
          <Row label="Project">
            {daemon.projectRoot === undefined ? (
              <span className="dim">not set</span>
            ) : (
              <span className="mono small">{daemon.projectRoot}</span>
            )}
          </Row>
          <Row label="Entry">
            <span className="mono small">{daemon.entry}</span>
          </Row>
        </dl>
      </CardContent>
    </Card>
  );
}

export interface AutostartCardProps {
  readonly autostart: SystemAutostart;
  readonly engineMethod: SystemEngine['method'];
  readonly busy: boolean;
  readonly onToggle: (enabled: boolean) => void;
}

export function AutostartCard({ autostart, engineMethod, busy, onToggle }: AutostartCardProps): JSX.Element {
  const on = autostart.supported && autostart.plist && autostart.loaded;
  return (
    <Card className="system-card">
      <CardHeader>
        <CardTitle>Autostart</CardTitle>
        <CardDescription>Launch the dashboard at login (launchd, macOS only)</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="system-switch">
          <Switch
            aria-label="Launch at login"
            checked={on}
            disabled={!autostart.supported || busy}
            onCheckedChange={onToggle}
          />
          <span>{on ? 'On' : 'Off'}</span>
        </div>
        {!autostart.supported ? (
          <p className="dim small system-hint" data-hint="unsupported">
            {autostart.reason}
          </p>
        ) : null}
        {autostart.supported && autostart.plist && !autostart.loaded ? (
          <p className="dim small system-hint" data-hint="not-loaded">
            The agent is installed but not loaded (for example after <span className="mono">burnex down</span>). Run{' '}
            <span className="mono">burnex up --install</span> or switch autostart on to load it.
          </p>
        ) : null}
        {autostart.supported && autostart.loaded && autostart.entryStable === false && engineMethod === 'managed' ? (
          <p className="dim small system-hint" data-hint="pinned-release">
            The agent points at a specific release (<span className="mono">{autostart.entry}</span>), not at{' '}
            <span className="mono">current</span>: an update would leave it on the old code. Switch autostart off and on
            again, or run <span className="mono">burnex up --install</span>, to pin it to <span className="mono">current</span>.
          </p>
        ) : null}
        {autostart.supported && autostart.loaded && !autostart.thisDaemon ? (
          <p className="dim small system-hint" data-hint="other-daemon">
            This dashboard was not started by the agent: the agent runs as PID{' '}
            <span className="mono">{autostart.pid ?? '?'}</span>.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function describeCheck(update: SystemUpdate | undefined): { readonly text: string; readonly tone: 'ok' | 'warn' | 'info' } | undefined {
  if (update === undefined) return undefined;
  if (update.error !== undefined) return { text: update.error, tone: 'warn' };
  const check = update.check;
  if (check === undefined) return undefined;
  switch (check.status) {
    case 'available':
      if (check.latest !== undefined) return { text: `Update available: ${check.current} → ${check.latest}`, tone: 'info' };
      if (check.commits !== undefined) return { text: `Update available: ${check.commits} new commit${check.commits === 1 ? '' : 's'} upstream`, tone: 'info' };
      return { text: 'Update may be available: the install method checks on its own', tone: 'info' };
    case 'up-to-date':
      return { text: `Up to date (${check.version})`, tone: 'ok' };
    case 'blocked':
    case 'no-tags':
      return { text: check.hint === undefined ? check.reason : `${check.reason}. ${check.hint}`, tone: 'warn' };
    case 'unknown':
      return { text: `Could not check: ${check.reason}`, tone: 'warn' };
  }
}

/** Причина, по которой «Update» неактивна, либо `undefined`, если её можно нажать. */
export function updateDisabledReason(engine: SystemEngine, update: SystemUpdate | undefined): string | undefined {
  if (engine.error !== undefined) return engine.error;
  if (update === undefined) return 'Check for updates first';
  if (update.error !== undefined) return update.error;
  const check = update.check;
  if (check === undefined) return 'Check for updates first';
  switch (check.status) {
    case 'up-to-date':
      return `Already up to date (${check.version})`;
    case 'blocked':
    case 'no-tags':
      return check.reason;
    case 'available':
    case 'unknown':
      // `unknown` — решает человек: сеть могла моргнуть, а `burnex update` повторит проверку сам.
      return undefined;
  }
}

export interface ActionState {
  readonly kind: SystemActionKind;
  readonly phase: 'starting' | 'waiting' | 'finished' | 'timeout' | 'rejected';
  readonly error?: string;
  readonly log?: readonly string[];
  /** Для `finished`: процесс вышел, а демон остался прежним — перезапуска не было. */
  readonly exitCode?: number | null;
}

export interface UpdateCardProps {
  readonly engine: SystemEngine;
  readonly update: SystemUpdate | undefined;
  readonly checking: boolean;
  readonly action: ActionState | undefined;
  readonly onCheck: () => void;
  readonly onUpdate: () => void;
}

export function UpdateCard({ engine, update, checking, action, onCheck, onUpdate }: UpdateCardProps): JSX.Element {
  const summary = describeCheck(update);
  const disabledReason = updateDisabledReason(engine, update);
  const running = action !== undefined && (action.phase === 'starting' || action.phase === 'waiting');
  return (
    <Card className="system-card">
      <CardHeader>
        <CardTitle>Update</CardTitle>
        <CardDescription>The same check and the same command as burnex update</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="system-buttons">
          <Button variant="outline" size="sm" disabled={checking || running || engine.error !== undefined} onClick={onCheck}>
            {checking ? 'Checking…' : 'Check for updates'}
          </Button>
          <Button size="sm" disabled={disabledReason !== undefined || running} title={disabledReason} onClick={onUpdate}>
            {running && action.kind === 'update' ? 'Updating…' : 'Update'}
          </Button>
        </div>
        {summary === undefined ? null : (
          <p className={`small system-hint system-check--${summary.tone}`} data-check={update?.check?.status ?? 'error'}>
            {summary.text}
            {update === undefined ? null : (
              <span className="dim">
                {' '}
                · checked {fmtTime(update.checkedAt)}
                {update.held ? ' (remembered by the daemon; Check for updates asks again)' : ''}
              </span>
            )}
          </p>
        )}
        {/* Исход проверки сам называет причину в строке выше; здесь — то, что иначе осталось бы без слов. */}
        {disabledReason !== undefined && (summary === undefined || engine.error !== undefined) ? (
          <p className="dim small system-hint" data-reason="update-disabled">
            Update is unavailable: {disabledReason}
          </p>
        ) : null}
        <p className="dim small system-hint">
          Updating restarts the dashboard: this page goes away for a few seconds and reconnects on its own.
        </p>
      </CardContent>
    </Card>
  );
}

/** Ход действия с экрана: ожидание нового pid, отказ и таймаут с журналом. */
export function ActionStatus({ action }: { readonly action: ActionState }): JSX.Element {
  if (action.phase === 'starting' || action.phase === 'waiting') {
    return (
      <Alert className="system-note" data-action={action.phase}>
        <AlertTitle>{action.kind === 'update' ? 'Updating' : 'Switching autostart'}…</AlertTitle>
        <AlertDescription>Waiting for the daemon to come back with a new PID (up to {RESTART_WAIT_MS / 1000} s).</AlertDescription>
      </Alert>
    );
  }
  if (action.phase === 'finished') {
    const ok = action.exitCode === 0;
    return (
      <Alert variant={ok ? 'default' : 'destructive'} className="system-note" data-action="finished">
        <AlertTitle>
          {ok
            ? 'The command finished without restarting the daemon'
            : `The command failed (${action.exitCode === null || action.exitCode === undefined ? 'killed or not started' : `exit code ${action.exitCode}`})`}
        </AlertTitle>
        <AlertDescription>
          {ok
            ? 'Nothing was changed that needs a restart — see the log below.'
            : <>
                The daemon was not restarted. Run it in a terminal: <span className="mono">{TERMINAL_COMMAND[action.kind]}</span>
              </>}
        </AlertDescription>
        {action.log === undefined || action.log.length === 0 ? null : (
          <pre className="system-log mono small">{action.log.join('\n')}</pre>
        )}
      </Alert>
    );
  }
  if (action.phase === 'rejected') {
    return (
      <Alert variant="destructive" className="system-note" data-action="rejected">
        <AlertTitle>The daemon refused the action</AlertTitle>
        <AlertDescription>{action.error}</AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive" className="system-note" data-action="timeout">
      <AlertTitle>The daemon did not come back in {RESTART_WAIT_MS / 1000} s</AlertTitle>
      <AlertDescription>
        Run it in a terminal: <span className="mono">{TERMINAL_COMMAND[action.kind]}</span>
        {action.kind === 'autostart' ? (
          <>
            {' '}
            (to switch off: <span className="mono">burnex down --uninstall && burnex up</span>)
          </>
        ) : null}
      </AlertDescription>
      {action.log === undefined || action.log.length === 0 ? null : (
        <pre className="system-log mono small">{action.log.join('\n')}</pre>
      )}
    </Alert>
  );
}

function ProbeCell({ probe }: { readonly probe: SystemProbe }): JSX.Element {
  if (probe.status === 'not-probed') return <span className="dim">not probed</span>;
  if (probe.status === 'ok') return <Badge variant="success">{probe.modelCount ?? 0} models</Badge>;
  if (probe.status === 'unsupported') return <span className="dim">cannot list models</span>;
  return (
    <>
      <Badge variant="destructive">{probe.status.replace('_', ' ')}</Badge>
      {probe.message === undefined ? null : <span className="dim small system-message"> {probe.message}</span>}
    </>
  );
}

function RefusalLine({ refusal }: { readonly refusal: SystemRefusal }): JSX.Element {
  return (
    <div className="system-refusal" data-refusal={refusal.class}>
      <Badge variant="destructive">{refusal.class === 'unauthenticated' ? 'unauthenticated' : 'rate limit'}</Badge>{' '}
      <span className="small">{fmtTime(refusal.at)}</span>{' '}
      <span className="dim small">
        {refusal.project} · run <span className="mono">{refusal.run}</span> · {refusal.job}/{refusal.step}
        {refusal.statusCode === undefined ? '' : ` · HTTP ${refusal.statusCode}`}
      </span>
      <div className="small system-message">{refusal.message}</div>
    </div>
  );
}

function BackendRow({ backend }: { readonly backend: SystemBackend }): JSX.Element {
  return (
    <tr>
      <td className="mono">
        {backend.id}
        {backend.enabled ? null : (
          <>
            {' '}
            <Badge variant="outline">disabled</Badge>
          </>
        )}
        {backend.adapter ? null : (
          <>
            {' '}
            <Badge variant="secondary">no adapter</Badge>
          </>
        )}
      </td>
      <td>
        <span className="mono">{backend.command}</span>{' '}
        {backend.commandState.status === 'found' ? (
          <>
            <Badge variant="success">found</Badge>
            <div className="dim small mono">{backend.commandState.path}</div>
          </>
        ) : (
          <Badge variant="destructive">missing</Badge>
        )}
      </td>
      <td>
        <ProbeCell probe={backend.probe} />
      </td>
      <td>
        {backend.refusals.length === 0 ? (
          <span className="dim">—</span>
        ) : (
          backend.refusals.map((refusal) => <RefusalLine key={refusal.class} refusal={refusal} />)
        )}
      </td>
    </tr>
  );
}

export interface BackendsSectionProps {
  readonly overview: SystemOverview;
  readonly probing: boolean;
  readonly onProbe: () => void;
}

export function BackendsSection({ overview, probing, onProbe }: BackendsSectionProps): JSX.Element {
  return (
    <section className="system-section">
      <div className="system-section-head">
        <h2>Backends</h2>
        <Button variant="outline" size="sm" disabled={probing} onClick={onProbe}>
          {probing ? 'Checking…' : 'Check'}
        </Button>
      </div>
      <p className="dim small">
        Check lists the models of every backend (one short process each). {AUTH_NOTE}
      </p>
      {overview.backendsError === undefined ? null : (
        <Alert variant="destructive">
          <AlertTitle>Backends cannot be read</AlertTitle>
          <AlertDescription>{overview.backendsError}</AlertDescription>
        </Alert>
      )}
      {overview.backends.length === 0 ? null : (
        <table className="system-table">
          <thead>
            <tr>
              <th>Backend</th>
              <th>Command</th>
              <th>Models</th>
              <th>Last refusal</th>
            </tr>
          </thead>
          <tbody>
            {overview.backends.map((backend) => (
              <BackendRow key={backend.id} backend={backend} />
            ))}
          </tbody>
        </table>
      )}
      {overview.unattributedRefusals.length === 0 ? null : (
        <div className="system-unattributed" data-section="unattributed">
          <h3>Refusals without a backend</h3>
          <p className="dim small">
            The run usage summary names no attempt for these steps, so the refusal is not blamed on any backend.
          </p>
          {overview.unattributedRefusals.map((refusal) => (
            <RefusalLine key={refusal.class} refusal={refusal} />
          ))}
        </div>
      )}
    </section>
  );
}

export function UnpricedSection({ unpriced }: { readonly unpriced: SystemOverview['unpriced'] }): JSX.Element {
  return (
    <section className="system-section">
      <h2>Models without price</h2>
      <p className="dim small">
        Calls the budget cannot see in money: the backend does not report a cost and the price catalog does not know the
        model.{unpriced.asOf === undefined ? ' The price catalog could not be read.' : ` Price catalog as of ${unpriced.asOf}.`}
      </p>
      {unpriced.models.length === 0 ? (
        <p className="dim small">Every model named in the configuration has a price.</p>
      ) : (
        <table className="system-table">
          <thead>
            <tr>
              <th>Backend</th>
              <th>Model</th>
              <th>Configured at</th>
            </tr>
          </thead>
          <tbody>
            {unpriced.models.map((row) => (
              <tr key={`${row.backend}:${row.path ?? ''}`}>
                <td className="mono">{row.backend}</td>
                <td>{row.model === null ? <span className="dim">CLI default model</span> : <span className="mono">{row.model}</span>}</td>
                <td className="mono small">{row.path ?? <span className="dim">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export interface SystemPanelsProps {
  readonly overview: SystemOverview;
  readonly update: SystemUpdate | undefined;
  readonly checking: boolean;
  readonly probing: boolean;
  readonly action: ActionState | undefined;
  readonly onCheck: () => void;
  readonly onUpdate: () => void;
  readonly onToggleAutostart: (enabled: boolean) => void;
  readonly onProbe: () => void;
}

/** Разметка по готовым ответам — отдельно от загрузки, чтобы проверяться статическим рендером. */
export function SystemPanels(props: SystemPanelsProps): JSX.Element {
  const { overview, action } = props;
  const running = action !== undefined && (action.phase === 'starting' || action.phase === 'waiting');
  return (
    <>
      {action === undefined ? null : <ActionStatus action={action} />}
      <div className="system-cards">
        <EngineCard engine={overview.engine} />
        <DaemonCard daemon={overview.daemon} />
        <AutostartCard
          autostart={overview.autostart}
          engineMethod={overview.engine.method}
          busy={running}
          onToggle={props.onToggleAutostart}
        />
        <UpdateCard
          engine={overview.engine}
          update={props.update}
          checking={props.checking}
          action={action}
          onCheck={props.onCheck}
          onUpdate={props.onUpdate}
        />
      </div>
      <BackendsSection overview={overview} probing={props.probing} onProbe={props.onProbe} />
      <UnpricedSection unpriced={overview.unpriced} />
    </>
  );
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function System(): JSX.Element {
  const [overview, setOverview] = useState<SystemOverview | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [update, setUpdate] = useState<SystemUpdate | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const [probing, setProbing] = useState(false);
  const [action, setAction] = useState<ActionState | undefined>(undefined);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback((): void => {
    fetchSystem()
      .then((data) => {
        setOverview(data);
        setError(undefined);
      })
      .catch((failure: Error) => setError(failure.message));
  }, []);

  useEffect(load, [load]);

  const check = useCallback((): void => {
    setChecking(true);
    // Кнопка спрашивает заново: удержанное демоном — для автоматического чтения, не для явного клика.
    fetchSystemUpdate(true)
      .then(setUpdate)
      .catch((failure: Error) => setUpdate({ checkedAt: new Date().toISOString(), held: false, error: failure.message }))
      .finally(() => setChecking(false));
  }, []);

  const probe = useCallback((): void => {
    setProbing(true);
    fetchModels(true)
      .catch(() => undefined)
      .finally(() => {
        setProbing(false);
        load();
      });
  }, [load]);

  /**
   * Действие перезапускает демон: ответ `202` — только порождение процесса.
   * Вернувшимся демон считается, когда `GET /api/system` отвечает другим pid;
   * ошибки запросов в это окно — норма, пока порт пуст. Если прежний демон
   * отвечает, а его процесс обслуживания уже вышел, перезапуска не будет
   * («обновлять нечего», отказ, сбой) — ждать до таймаута незачем.
   */
  const perform = useCallback(
    async (kind: SystemActionKind, start: () => Promise<unknown>): Promise<void> => {
      const before = overview?.daemon.pid;
      setAction({ kind, phase: 'starting' });
      try {
        await start();
      } catch (failure) {
        setAction({ kind, phase: 'rejected', error: (failure as Error).message });
        return;
      }
      setAction({ kind, phase: 'waiting' });

      const deadline = Date.now() + RESTART_WAIT_MS;
      while (Date.now() < deadline) {
        await sleep(POLL_MS);
        if (!alive.current) return;
        try {
          const next = await fetchSystem();
          if (next.daemon.pid !== before) {
            setOverview(next);
            setUpdate(undefined);
            setAction(undefined);
            return;
          }
          const journal = await fetchSystemLog(kind);
          if (journal.run !== undefined && !journal.run.running) {
            if (!alive.current) return;
            setOverview(next);
            setUpdate(undefined);
            setAction({ kind, phase: 'finished', exitCode: journal.run.exitCode ?? null, log: journal.lines });
            return;
          }
        } catch {
          // Демон ещё не вернулся.
        }
      }

      let log: readonly string[] = [];
      try {
        log = (await fetchSystemLog(kind)).lines;
      } catch {
        // Журнал недоступен — команда для терминала всё равно показана.
      }
      if (alive.current) setAction({ kind, phase: 'timeout', log });
    },
    [overview?.daemon.pid],
  );

  return (
    <>
      <PageHeader title={PAGE_TITLE} description={PAGE_DESCRIPTION} />
      {error !== undefined ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load the system state</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {overview === undefined ? (
        error === undefined ? <EmptyState title="Loading…" /> : null
      ) : (
        <SystemPanels
          overview={overview}
          update={update}
          checking={checking}
          probing={probing}
          action={action}
          onCheck={check}
          onUpdate={() => void perform('update', startSystemUpdate)}
          onToggleAutostart={(enabled) => void perform('autostart', () => setSystemAutostart(enabled))}
          onProbe={probe}
        />
      )}
    </>
  );
}
