import type { JSX, ReactNode } from 'react';

import { declaration as agentsDeclaration } from '../../../src/parts/ui/screens/agents/declaration.ts';
import { declaration as backlogDeclaration } from '../../../src/parts/ui/screens/backlog/declaration.ts';
import { declaration as cleanupDeclaration } from '../../../src/parts/ui/screens/cleanup/declaration.ts';
import { declaration as decisionsDeclaration } from '../../../src/parts/ui/screens/decisions/declaration.ts';
import { declaration as pipelinesDeclaration } from '../../../src/parts/ui/screens/pipelines/declaration.ts';
import { declaration as packagesDeclaration } from '../../../src/parts/ui/screens/packages/declaration.ts';
import { declaration as proposalsDeclaration } from '../../../src/parts/ui/screens/proposals/declaration.ts';
import { declaration as routesDeclaration } from '../../../src/parts/ui/screens/routes/declaration.ts';
import { declaration as runsDeclaration } from '../../../src/parts/ui/screens/runs/declaration.ts';
import { declaration as scrumDeclaration } from '../../../src/parts/ui/screens/scrum/declaration.ts';
import { declaration as scheduleDeclaration } from '../../../src/parts/ui/screens/schedule/declaration.ts';
import { declaration as secretsDeclaration } from '../../../src/parts/ui/screens/secrets/declaration.ts';
import { declaration as systemDeclaration } from '../../../src/parts/ui/screens/system/declaration.ts';
import { declaration as usageDeclaration } from '../../../src/parts/ui/screens/usage/declaration.ts';
import { declaration as widgetsDeclaration } from '../../../src/parts/ui/screens/widgets/declaration.ts';
import type { RouteTarget } from '../../../src/parts/ui/routes.ts';
import type { Overview, ProposalsStreamEvent } from '../api';
import { fmtMoney } from '../format';
import { TargetLink } from '../routeLink';
import { PageHeader } from '@stepcast/ui';
import './home.css';

/**
 * Экран «Home» (`ui-home-screen`) — стартовая страница витрины. Отвечает на
 * три вопроса человека, открывшего корень: что это за приложение, что демон
 * видит прямо сейчас и куда идти дальше. Данных сверх тех, что каркас и так
 * раздаёт экранам (`overview`, `proposals`), не запрашивает: полоса состояния
 * — свёртка обзора, карта разделов — ссылки на цели маршрутов через
 * `TargetLink`, так что отключённый маршрут честно называет причину на месте.
 */

export interface HomeStats {
  readonly projects: number;
  readonly running: number;
  readonly awaiting: number;
  readonly pendingProposals: number;
  readonly runsToday: number;
  readonly costToday: number;
}

function isToday(iso: string | undefined, now: Date): boolean {
  if (iso === undefined) return false;
  const at = new Date(iso);
  return at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
}

/** Свёртка обзора и очереди предложений в числа полосы состояния — чистая функция ради проверки без DOM. */
export function homeStats(
  overview: Overview | undefined,
  proposals: ProposalsStreamEvent | undefined,
  now: Date = new Date(),
): HomeStats {
  let running = 0;
  let awaiting = 0;
  let runsToday = 0;
  let costToday = 0;
  for (const project of overview?.projects ?? []) {
    for (const run of project.runs) {
      if (run.running) running += 1;
      awaiting += run.awaiting?.length ?? 0;
      if (isToday(run.startedAt, now)) {
        runsToday += 1;
        costToday += run.usage?.costUsd ?? 0;
      }
    }
  }
  let pendingProposals = 0;
  for (const project of proposals?.projects ?? []) {
    pendingProposals += project.records.filter((record) => record.state === 'pending').length;
  }
  return { projects: overview?.projects.length ?? 0, running, awaiting, pendingProposals, runsToday, costToday };
}

const screenTarget = (id: string): RouteTarget => ({ kind: 'screen', id });

interface SectionEntry {
  readonly target: RouteTarget;
  readonly title: string;
  readonly description: string;
}

interface SectionGroup {
  readonly label: string;
  readonly entries: readonly SectionEntry[];
}

/**
 * Карта разделов — по группам меню поставки. Описания живут здесь, а не в
 * объявлениях экранов: объявление — общий модуль двух половин без единого
 * импорта, и тащить в него текст для одной страницы незачем.
 */
export const SECTIONS: readonly SectionGroup[] = [
  {
    label: 'Work',
    entries: [
      {
        target: screenTarget(runsDeclaration.id),
        title: runsDeclaration.title,
        description: 'Every run across all projects: status, duration, cost; open one for its jobs and steps.',
      },
      {
        target: screenTarget(pipelinesDeclaration.id),
        title: pipelinesDeclaration.title,
        description: 'How each project’s pipelines are wired: job graph, transitions, steps and agent selection.',
      },
      {
        target: screenTarget(backlogDeclaration.id),
        title: backlogDeclaration.title,
        description: 'Improvement queue of every project the daemon sees, in file order.',
      },
      {
        target: screenTarget(scrumDeclaration.id),
        title: scrumDeclaration.title,
        description: 'One project’s queue in columns; drag a card to change its status or start a pipeline.',
      },
      {
        target: screenTarget(decisionsDeclaration.id),
        title: decisionsDeclaration.title,
        description: 'Runs paused at a step that waits for a human answer.',
      },
      {
        target: screenTarget(proposalsDeclaration.id),
        title: proposalsDeclaration.title,
        description: 'Changes an agent proposed to a project’s .stepcast/ files, with a diff to accept or reject.',
      },
    ],
  },
  {
    label: 'Extend',
    entries: [
      {
        target: screenTarget(widgetsDeclaration.id),
        title: widgetsDeclaration.title,
        description: 'Small React components rendered on this dashboard: the bundled catalog and what each project installed.',
      },
      {
        target: screenTarget(packagesDeclaration.id),
        title: packagesDeclaration.title,
        description: 'Packages of the project and home layers: what each brings, whether it is in effect, and which resources failed.',
      },
      {
        target: screenTarget(routesDeclaration.id),
        title: routesDeclaration.title,
        description: 'Every address the dashboard resolves, its target and menu place; edit them per layer.',
      },
    ],
  },
  {
    label: 'System',
    entries: [
      {
        target: screenTarget(usageDeclaration.id),
        title: usageDeclaration.title,
        description: 'Cost and tokens across all runs for a period, by model and by pipeline.',
      },
      {
        target: screenTarget(cleanupDeclaration.id),
        title: cleanupDeclaration.title,
        description: 'Free disk space by deleting run files or trimming the usage history, with a preview first.',
      },
      {
        target: screenTarget(agentsDeclaration.id),
        title: agentsDeclaration.title,
        description: 'Who runs the agent steps and with which model: defaults, backends, tiers and per-pipeline policy.',
      },
      {
        target: screenTarget(secretsDeclaration.id),
        title: secretsDeclaration.title,
        description: 'Which secrets the pipelines and backends expect and whether each one resolves here; values are never shown.',
      },
      {
        target: screenTarget(scheduleDeclaration.id),
        title: scheduleDeclaration.title,
        description: 'Which pipelines are declared on a schedule, the next moment and the last scheduled run; read-only.',
      },
      {
        target: screenTarget(systemDeclaration.id),
        title: systemDeclaration.title,
        description: 'Engine version and install method, the daemon, autostart, backends and models without a price.',
      },
    ],
  },
];

function StatTile({
  value,
  label,
  target,
  navigate,
  attention,
}: {
  readonly value: ReactNode;
  readonly label: string;
  readonly target: RouteTarget;
  readonly navigate: (href: string) => void;
  /** Число требует действия человека — плитка подсвечена, пока оно не ноль. */
  readonly attention?: boolean;
}): JSX.Element {
  return (
    <TargetLink target={target} navigate={navigate} className={attention === true ? 'home-stat attention' : 'home-stat'}>
      <span className="home-stat-value">{value}</span>
      <span className="home-stat-label">{label}</span>
    </TargetLink>
  );
}

export function Home({
  overview,
  proposals,
  navigate,
}: {
  readonly overview: Overview | undefined;
  readonly proposals: ProposalsStreamEvent | undefined;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  const stats = homeStats(overview, proposals);
  const loading = overview === undefined;
  const show = (value: ReactNode): ReactNode => (loading ? '…' : value);

  return (
    <div className="home">
      <PageHeader
        title="burnex"
        description="The dashboard of the stepcast daemon — a pipeline engine for development with AI agents."
      />

      <section className="home-intro">
        <p>
          A pipeline declares jobs, their order and transitions; an agent is one kind of step inside a job, not the
          orchestrator. The engine runs the pipeline, checks every result against its contract, retries or stops by
          the declared budget, and writes a journal of every run.
        </p>
        <p>
          The daemon behind this page watches the run journals of every project it knows about, launches pipelines
          on request and keeps this dashboard live. The engine and its CLI are called <code>stepcast</code>; burnex is
          the name of this dashboard.
        </p>
      </section>

      <section className="home-section" aria-label="Right now">
        <h2 className="home-section-title">Right now</h2>
        <div className="home-stats">
          <StatTile value={show(stats.projects)} label="projects" target={screenTarget(runsDeclaration.id)} navigate={navigate} />
          <StatTile
            value={show(stats.running)}
            label="running"
            target={screenTarget(runsDeclaration.id)}
            navigate={navigate}
            attention={stats.running > 0}
          />
          <StatTile
            value={show(stats.awaiting)}
            label="awaiting a decision"
            target={screenTarget(decisionsDeclaration.id)}
            navigate={navigate}
            attention={stats.awaiting > 0}
          />
          <StatTile
            value={proposals === undefined ? '…' : stats.pendingProposals}
            label="pending proposals"
            target={screenTarget(proposalsDeclaration.id)}
            navigate={navigate}
            attention={stats.pendingProposals > 0}
          />
          <StatTile value={show(stats.runsToday)} label="runs started today" target={screenTarget(usageDeclaration.id)} navigate={navigate} />
          <StatTile value={show(stats.costToday === 0 ? '$0.00' : fmtMoney(stats.costToday))} label="spent today" target={screenTarget(usageDeclaration.id)} navigate={navigate} />
        </div>
      </section>

      {SECTIONS.map((group) => (
        <section className="home-section" key={group.label} aria-label={group.label}>
          <h2 className="home-section-title">{group.label}</h2>
          <div className="home-cards">
            {group.entries.map((entry) => (
              <TargetLink key={entry.target.id} target={entry.target} navigate={navigate} className="home-card">
                <span className="home-card-title">{entry.title}</span>
                <span className="home-card-description">{entry.description}</span>
              </TargetLink>
            ))}
          </div>
        </section>
      ))}

      <section className="home-section" aria-label="From the terminal">
        <h2 className="home-section-title">From the terminal</h2>
        <dl className="home-commands">
          <dt>
            <code>stepcast run &lt;pipeline.yml&gt;</code>
          </dt>
          <dd>Start a pipeline in the current project; the run appears in Runs as it goes.</dd>
          <dt>
            <code>stepcast lint &lt;pipeline.yml&gt;</code>
          </dt>
          <dd>Check a pipeline file before running it.</dd>
          <dt>
            <code>stepcast up</code> · <code>stepcast down</code>
          </dt>
          <dd>Start or stop the daemon that serves this dashboard.</dd>
        </dl>
      </section>
    </div>
  );
}
