import type { PipelinePlugin } from '../pipeline/surface.js';
import codexPlugin from './codex/index.js';
import antigravityPlugin from './antigravity/index.js';
import copilotPlugin from './copilot/index.js';
import cursorPlugin from './cursor/index.js';

/**
 * Адаптеры, которые поставляются в пакете, но не встроены: каждый включается
 * строкой в `plugins:`. Витрина по этому перечню рисует карточки до
 * подключения и по нему же отказывает на имени, которого здесь нет, — перечень
 * лежит вне `codex|cursor|copilot|antigravity/**`, чтобы не нарушать границу плагина.
 * `claude` встроен и сюда не входит. Порядок — порядок карточек.
 */
export interface BundledBackend {
  /** Строка для `plugins:` — тот же подпуть, что в `exports` пакета. */
  readonly specifier: string;
  readonly plugin: PipelinePlugin;
}

export const BUNDLED_BACKENDS: readonly BundledBackend[] = [
  { specifier: 'burnex/backends/codex', plugin: codexPlugin },
  { specifier: 'burnex/backends/cursor', plugin: cursorPlugin },
  { specifier: 'burnex/backends/copilot', plugin: copilotPlugin },
  { specifier: 'burnex/backends/antigravity', plugin: antigravityPlugin },
];

/** Имя бэкенда (не плагина) → запись каталога, которая его даёт. */
export function bundledByBackend(name: string): BundledBackend | undefined {
  return BUNDLED_BACKENDS.find((entry) => Object.hasOwn(entry.plugin.backends ?? {}, name));
}
