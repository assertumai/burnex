import type { ScreenDeclaration } from '../declaration.js';

/**
 * Экран «Home» (`ui-home-screen`): стартовая страница витрины — что это за
 * приложение, что демон видит прямо сейчас и куда идти дальше. Своего
 * маршрута чтения не заводит: полоса состояния собрана из обзора и очереди
 * предложений, которые каркас и так раздаёт экранам потоком `GET /api/events`.
 */
export const declaration: ScreenDeclaration = {
  id: 'screen-home',
  title: 'Home',
  params: [],
};
