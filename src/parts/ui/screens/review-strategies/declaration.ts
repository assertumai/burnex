import type { ScreenDeclaration } from '../declaration.js';

export const declaration: ScreenDeclaration = {
  id: 'screen-review-strategies',
  title: 'Review strategies',
  /** Выбранная стратегия — из адреса (`/review-strategies/:name?`). */
  params: ['name'],
};
