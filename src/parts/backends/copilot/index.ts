import { defineBackend, definePipelinePlugin } from '../../pipeline/surface.js';
import { createCopilotAdapter } from './adapter.js';

/**
 * Плагин GitHub Copilot: `plugins: [stepcast/backends/copilot]`.
 *
 * Поставляется в пакете, но не встроен: `builtinPlugin()` его не знает, и без
 * объявления бэкенда `copilot` не существует. Умолчания честны: CLI не умеет
 * сессии, MCP, структурированный вывод и жёсткий режим прав, поэтому
 * соответствующие флаги выключены, а шаги, которые их просят, отклоняются
 * предстартовыми проверками движка. Перечня моделей и `default_model` нет:
 * набор моделей зависит от аккаунта, и без `--model` CLI берёт свою.
 */
const plugin = definePipelinePlugin({
  name: 'copilot',
  version: '0.1.0',
  backends: {
    copilot: defineBackend({
      create: (config) => createCopilotAdapter(config),
      defaults: {
        command: 'copilot',
        sessions: false,
        structured_output: false,
        strict_permissions: false,
        mcp: false,
        concurrency: 2,
      },
    }),
  },
});

export default plugin;
export { createCopilotAdapter, MAX_ARG_BYTES } from './adapter.js';
