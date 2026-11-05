import { defineBackend, definePipelinePlugin } from '../../pipeline/surface.js';
import { createCursorAdapter } from './adapter.js';
import { cursorModelDiscovery } from './models.js';

/**
 * Плагин Cursor: `plugins: [burnex/backends/cursor]`.
 *
 * Поставляется в пакете, но не встроен: `builtinPlugin()` его не знает, и без
 * объявления бэкенда `cursor-agent` не существует. Умолчания честны: CLI не
 * умеет MCP, структурированный вывод и жёсткий режим прав, поэтому
 * соответствующие флаги выключены, а шаги, которые их просят, отклоняются
 * предстартовыми проверками движка. `default_model` нет: набор моделей зависит
 * от аккаунта, и без него CLI берёт свою модель (`auto`).
 */
const plugin = definePipelinePlugin({
  name: 'cursor',
  version: '0.1.0',
  backends: {
    'cursor-agent': defineBackend({
      create: (config) => createCursorAdapter(config),
      models: cursorModelDiscovery,
      defaults: {
        command: 'cursor-agent',
        sessions: true,
        structured_output: false,
        strict_permissions: false,
        mcp: false,
        concurrency: 2,
      },
    }),
  },
});

export default plugin;
export { createCursorAdapter, SANDBOX_MODES } from './adapter.js';
export { cursorModelDiscovery, parseCursorModelList } from './models.js';
