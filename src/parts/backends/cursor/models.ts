import type {
  BackendConfig,
  BackendModel,
  LaunchSpec,
  ModelDiscovery,
  ProbeOutput,
} from '../../pipeline/surface.js';

/** Перечень моделей аккаунта: `cursor-agent models`. */
export const cursorModelDiscovery: ModelDiscovery = {
  probe(config: BackendConfig): LaunchSpec {
    return { command: [config.command, 'models'], stdin: '' };
  },
  parse(output: ProbeOutput): readonly BackendModel[] {
    return parseCursorModelList(output.stdout);
  },
};

/** `<slug> - <название>`; slug — без пробелов, чтобы заголовок и подсказки не сходили за модель. */
const MODEL_LINE = /^([A-Za-z0-9][A-Za-z0-9._:/-]*) - (.+)$/;

/** Пометка текущей или умолчательной модели в конце названия — не часть названия. */
const MARKER = /\s*\((?:current|default)\)\s*$/i;

/**
 * Разбор вывода `cursor-agent models`. Неразборный вывод даёт пустой список, а
 * не догадки. Effort у моделей не заполняется: у Cursor уровень рассуждений
 * зашит в имя модели (`…-thinking`), отдельного параметра нет.
 */
export function parseCursorModelList(stdout: string): readonly BackendModel[] {
  const seen = new Set<string>();
  const models: BackendModel[] = [];
  for (const line of stdout.split('\n')) {
    const match = MODEL_LINE.exec(line.trim());
    if (match === null) continue;
    const name = match[1] as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const label = (match[2] as string).replace(MARKER, '').trim();
    models.push({ name, ...(label === '' ? {} : { label }) });
  }
  return models;
}
