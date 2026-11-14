import type { ScreenDeclaration } from '../declaration.js';

export const declaration: ScreenDeclaration = {
  id: 'screen-discussion-strategies',
  title: 'Discussion strategies',
  /** Выбранная стратегия — из адреса (`/discussion-strategies/:name?`). */
  params: ['name'],
};
