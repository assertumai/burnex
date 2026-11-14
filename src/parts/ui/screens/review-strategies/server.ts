import { REVIEW_STRATEGY } from '../../strategies.js';
import { strategiesScreenRow } from '../strategies.js';
import { declaration } from './declaration.js';

/** Серверная половина экрана «Review strategies» (`ui-review-strategies`) — общая строка экранов стратегий. */
export const row = strategiesScreenRow(declaration, '/api/review-strategies', REVIEW_STRATEGY);
