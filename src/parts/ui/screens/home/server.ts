import { screenRow } from '../registry.js';
import { declaration } from './declaration.js';

/** Строка экрана «Home»: одно объявление, маршрутов API нет (`ui-home-screen`). */
export const row = screenRow(declaration.id, ['screens'], (ctx) => {
  ctx.screens.register(declaration);
});
