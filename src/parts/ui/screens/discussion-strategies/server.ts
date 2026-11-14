import { DISCUSSION_STRATEGY } from '../../strategies.js';
import { strategiesScreenRow } from '../strategies.js';
import { declaration } from './declaration.js';

/** Серверная половина экрана «Discussion strategies» (`ui-discussion-strategies`) — общая строка экранов стратегий. */
export const row = strategiesScreenRow(declaration, '/api/discussion-strategies', DISCUSSION_STRATEGY);
