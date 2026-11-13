import { defineBackend, definePipelinePlugin } from '../../pipeline/surface.js';
import { createAntigravityAdapter } from './adapter.js';

/**
 * Плагин Google Antigravity CLI: `plugins: [burnex/backends/antigravity]`.
 *
 * Поставляется в пакете, но не встроен: без объявления бэкенда `antigravity`
 * не существует. Умолчания — по документации CLI: сессии (`--conversation`) и
 * схема (`--json-schema`) есть, MCP и жёсткого режима прав в командной строке
 * нет. Перечня моделей и `default_model` нет: набор зависит от плана, формат
 * `agy models` не задокументирован, и без `--model` CLI берёт свою модель.
 * Вживую адаптер не проверялся (`test/fixtures/antigravity/README.md`).
 */
const plugin = definePipelinePlugin({
  name: 'antigravity',
  version: '0.1.0',
  backends: {
    antigravity: defineBackend({
      create: (config) => createAntigravityAdapter(config),
      defaults: {
        command: 'agy',
        sessions: true,
        structured_output: true,
        strict_permissions: false,
        mcp: false,
        concurrency: 2,
      },
    }),
  },
});

export default plugin;
export { AGENT_MODES, createAntigravityAdapter, MAX_ARG_BYTES } from './adapter.js';
