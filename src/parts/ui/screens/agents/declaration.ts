import type { ScreenDeclaration } from '../declaration.js';

export const declaration: ScreenDeclaration = {
  id: 'screen-agents',
  title: 'Agents',
  /** Вкладка экрана — из адреса (`/agents/:tab?`), перечень значений объявлен маршрутом. */
  params: ['tab'],
};
