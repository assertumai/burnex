import type { Context } from 'cordis';

import agents from './agents';
import backlog from './backlog';
import cleanup from './cleanup';
import decisions from './decisions';
import home from './home';
import packages from './packages';
import pipelines from './pipelines';
import projects from './projects';
import proposals from './proposals';
import reviewStrategies from './review-strategies';
import discussionStrategies from './discussion-strategies';
import routes from './routes';
import run from './run';
import runs from './runs';
import schedule from './schedule';
import scrum from './scrum';
import secrets from './secrets';
import system from './system';
import usage from './usage';
import widgets from './widgets';

/**
 * Таблица «id → браузерная половина» встроенных экранов (design.md, Решение
 * 12, 14). Плагин `ui/src/plugins/screens.tsx` применяет запись, только если
 * демон назвал этот `id` в действующем составе (`GET /api/screens`) — вклад
 * встроенного экрана, которого демон не назвал, в бандле остаётся, но не
 * применяется.
 */
export type ScreenPlugin = (ctx: Context) => void;

export const BUILTIN_SCREENS: Readonly<Record<string, ScreenPlugin>> = {
  'screen-home': home,
  'screen-runs': runs,
  'screen-run': run,
  'screen-pipelines': pipelines,
  'screen-decisions': decisions,
  'screen-widgets': widgets,
  'screen-packages': packages,
  'screen-backlog': backlog,
  'screen-scrum': scrum,
  'screen-usage': usage,
  'screen-cleanup': cleanup,
  'screen-agents': agents,
  'screen-review-strategies': reviewStrategies,
  'screen-discussion-strategies': discussionStrategies,
  'screen-secrets': secrets,
  'screen-projects': projects,
  'screen-schedule': schedule,
  'screen-system': system,
  'screen-routes': routes,
  'screen-proposals': proposals,
};
