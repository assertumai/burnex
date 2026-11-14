import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';

import { BurnexError } from '../../../kernel/errors.js';
import { findPackageRoot } from '../../../kernel/packageRoot.js';
import { packagedSchemaPath } from '../domain/package-schema.js';
import { repairMermaidLabels } from './mermaidRepair.js';

/**
 * Рендеры проектного документа `burnex:design-doc` (`render-design`,
 * design.md, решения 2–5): разбор и проверка входа, офлайн-HTML и OpenSpec
 * `design.md`. Один код у команды `burnex render design` и у демона
 * (`GET /api/design-render`).
 *
 * Рендеры — чистые функции документа: ни дат, ни путей, ни случайных
 * идентификаторов. Одинаковый вход даёт одинаковые байты.
 */

export interface DesignRejected {
  readonly by: string;
  readonly summary: string;
  readonly reason: string;
}

export interface DesignDecision {
  readonly id: string;
  readonly question: string;
  readonly choice: string;
  readonly rationale: string;
  readonly rejected: readonly DesignRejected[];
}

export interface DesignDiagram {
  readonly id: string;
  readonly title: string;
  readonly kind: 'mermaid';
  readonly source: string;
  readonly decisions: readonly string[];
}

export interface DesignRisk {
  readonly risk: string;
  readonly mitigation: string;
}

/** Документ `burnex:design-doc` с необязательными полями движка шага `discuss`. */
export interface DesignDocument {
  readonly title: string;
  readonly summary: string;
  readonly decisions: readonly DesignDecision[];
  readonly diagrams: readonly DesignDiagram[];
  readonly risks: readonly DesignRisk[];
  readonly open_questions: readonly string[];
  readonly agreed?: boolean;
  readonly unresolved?: readonly string[];
  readonly changed_by_aggregator?: readonly string[];
}

export const DESIGN_FORMATS = ['html', 'openspec'] as const;
export type DesignFormat = (typeof DESIGN_FORMATS)[number];

export function isDesignFormat(value: string): value is DesignFormat {
  return (DESIGN_FORMATS as readonly string[]).includes(value);
}

const ENGINE_FIELDS = ['agreed', 'unresolved', 'changed_by_aggregator'] as const;

let validator: ValidateFunction | undefined;

function validateDoc(): ValidateFunction {
  if (validator === undefined) {
    const schema = JSON.parse(readFileSync(packagedSchemaPath('design-doc'), 'utf8')) as object;
    validator = new Ajv2020({ allErrors: false, strict: false }).compile(schema);
  }
  return validator;
}

/** Путь ключа первой ошибки ajv: `decisions.0.id`, а у отсутствующего ключа — сам ключ. */
function errorPath(error: ErrorObject): string {
  const segments = error.instancePath.split('/').slice(1).map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  const missing = (error.params as { missingProperty?: unknown }).missingProperty;
  const extra = (error.params as { additionalProperty?: unknown }).additionalProperty;
  if (typeof missing === 'string') segments.push(missing);
  else if (typeof extra === 'string') segments.push(extra);
  return segments.length === 0 ? '(корень)' : segments.join('.');
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Проверяет значение как документ `burnex:design-doc`. Поля движка снимаются
 * до проверки схемой — схема их не объявляет и закрыта
 * `additionalProperties: false` — и проверяются по типам отдельно.
 *
 * @throws BurnexError с путём первого ключа с ошибкой.
 */
export function parseDesignDocument(value: unknown, file?: string): DesignDocument {
  const fail = (message: string, at: string): never => {
    throw new BurnexError(message, {
      ...(file === undefined ? {} : { file }),
      at,
      hint: 'Рендер принимает документ формы burnex:design-doc — выход шага discuss с output_schema: burnex:design-doc',
    });
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('Документ — не JSON-объект', '(корень)');
  }
  const record = value as Record<string, unknown>;
  const body: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(record)) {
    if (!(ENGINE_FIELDS as readonly string[]).includes(key)) body[key] = field;
  }
  const validate = validateDoc();
  if (!validate(body)) {
    const error = validate.errors?.[0];
    return fail(`Документ не соответствует схеме burnex:design-doc: ${error?.message ?? 'отказ проверки'}`, error === undefined ? '(корень)' : errorPath(error));
  }
  if (record.agreed !== undefined && typeof record.agreed !== 'boolean') fail('Поле agreed — не boolean', 'agreed');
  for (const key of ['unresolved', 'changed_by_aggregator'] as const) {
    if (record[key] !== undefined && !isStringList(record[key])) fail(`Поле ${key} — не массив строк`, key);
  }
  return record as unknown as DesignDocument;
}

/** Читает и проверяет файл документа. */
export function readDesignDocument(path: string): DesignDocument {
  if (!existsSync(path)) {
    throw new BurnexError(`Файл документа не найден: ${path}`, { file: path });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new BurnexError(`Файл документа не разбирается как JSON: ${(cause as Error).message}`, { file: path });
  }
  return parseDesignDocument(parsed, path);
}

const HERE = fileURLToPath(new URL('.', import.meta.url));

/**
 * Бандл Mermaid, поставляемый пакетом: сборка (`scripts/copy-vendor.mjs`)
 * копирует его в `dist/vendor/` из devDependency `mermaid`.
 */
export function mermaidBundlePath(): string {
  return join(findPackageRoot(HERE), 'dist', 'vendor', 'mermaid.min.js');
}

function loadMermaidBundle(): string {
  const path = mermaidBundlePath();
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new BurnexError(`Бандл Mermaid не найден: ${path}`, {
      hint: 'Сборка пакета неполна — пересоберите burnex (npm run build), шаг копирования кладёт его в dist/vendor/',
    });
  }
}

/** Рендер документа в выбранный формат; бандл Mermaid читается, только если он нужен. */
export function renderDesign(document: DesignDocument, format: DesignFormat): string {
  if (format === 'openspec') return renderDesignOpenSpec(document);
  return renderDesignHtml(document, document.diagrams.length > 0 ? loadMermaidBundle() : undefined);
}

// ---------------------------------------------------------------------------
// Пометки итога — общие для обоих рендеров.

function notAgreedNote(document: DesignDocument): string | undefined {
  if (document.agreed !== false) return undefined;
  const points = document.unresolved ?? [];
  return points.length === 0 ? 'Итог не согласован.' : `Итог не согласован. Несогласованные точки: ${points.join(', ')}.`;
}

function changedNote(document: DesignDocument): string | undefined {
  const changed = document.changed_by_aggregator ?? [];
  return changed.length === 0 ? undefined : `Изменено агрегатором: ${changed.join(', ')}.`;
}

// ---------------------------------------------------------------------------
// HTML

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

/** Идентификатор, пригодный для `id` и `href="#…"`: всё лишнее — дефис. */
function anchor(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '-');
}

const STYLE = `
:root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6b6b70; --bg: #ffffff; --panel: #f5f5f7; --line: #dcdce0; --accent: #2f5bd3; --warn-bg: #fff4e0; --warn-fg: #7a4b00; --mark-bg: #eef2ff; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececf1; --muted: #a0a0aa; --bg: #17171a; --panel: #222227; --line: #3a3a42; --accent: #8aa8ff; --warn-bg: #3b2c12; --warn-fg: #ffd18a; --mark-bg: #262c45; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width: 920px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 1.7em; line-height: 1.25; margin: 0 0 16px; }
h2 { font-size: 1.25em; margin: 36px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
h3 { font-size: 1.05em; margin: 0 0 8px; }
p, li { white-space: pre-wrap; overflow-wrap: anywhere; }
a { color: var(--accent); }
.note { background: var(--warn-bg); color: var(--warn-fg); border-radius: 8px; padding: 10px 14px; margin: 0 0 10px; }
.note.changed { background: var(--mark-bg); color: var(--fg); }
.decision, .diagram { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin: 0 0 14px; }
.decision .choice { font-weight: 600; }
.badge { display: inline-block; font-size: 0.78em; font-weight: 600; border-radius: 999px; padding: 1px 8px; margin-left: 8px; vertical-align: middle; }
.badge.changed { background: var(--mark-bg); color: var(--accent); }
.badge.unresolved { background: var(--warn-bg); color: var(--warn-fg); }
.label { color: var(--muted); font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; margin: 10px 0 4px; }
.rejected li { margin: 4px 0; }
.by { color: var(--muted); }
pre { overflow-x: auto; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 12px; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre; }
pre.mermaid { text-align: center; background: transparent; border: none; white-space: pre; }
.diagram-error { color: var(--warn-fg); background: var(--warn-bg); border-radius: 6px; padding: 6px 10px; font-size: 0.9em; }
.refs { color: var(--muted); font-size: 0.9em; }
`;

const MERMAID_BOOT = `
var repairMermaidLabels = ${repairMermaidLabels.toString()};
(async function () {
  var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
  var blocks = Array.prototype.slice.call(document.querySelectorAll('pre.mermaid'));
  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i];
    try {
      await mermaid.parse(block.textContent);
    } catch (error) {
      // Частая ошибка агентов — подпись \`A[/путь]\` без кавычек: чиним и пробуем снова.
      var repaired = repairMermaidLabels(block.textContent);
      if (repaired !== block.textContent) {
        try {
          await mermaid.parse(repaired);
          block.textContent = repaired;
          continue;
        } catch (ignored) {}
      }
      block.classList.remove('mermaid');
      var message = document.createElement('p');
      message.className = 'diagram-error';
      message.textContent = 'Диаграмму не удалось отрисовать: ' + String((error && error.message) || error);
      block.after(message);
    }
  }
  await mermaid.run({ querySelector: 'pre.mermaid', suppressErrors: true });
})();
`;

function decisionHtml(decision: DesignDecision, document: DesignDocument): string {
  const changed = (document.changed_by_aggregator ?? []).includes(decision.id);
  const unresolved = (document.unresolved ?? []).includes(decision.id);
  const badges =
    (changed ? '<span class="badge changed">изменено агрегатором</span>' : '') +
    (unresolved ? '<span class="badge unresolved">не согласовано</span>' : '');
  const rejected =
    decision.rejected.length === 0
      ? ''
      : `<div class="label">Отклонено</div><ul class="rejected">${decision.rejected
          .map((item) => `<li>${escapeHtml(item.summary)} <span class="by">(${escapeHtml(item.by)})</span> — ${escapeHtml(item.reason)}</li>`)
          .join('')}</ul>`;
  return (
    `<section class="decision" id="${anchor(decision.id)}">` +
    `<h3>${escapeHtml(decision.id)}. ${escapeHtml(decision.question)}${badges}</h3>` +
    `<p class="choice">${escapeHtml(decision.choice)}</p>` +
    `<p>${escapeHtml(decision.rationale)}</p>` +
    rejected +
    '</section>'
  );
}

function decisionRefs(ids: readonly string[]): string {
  return ids.map((id) => `<a href="#${anchor(id)}">${escapeHtml(id)}</a>`).join(', ');
}

function diagramHtml(diagram: DesignDiagram): string {
  const refs = diagram.decisions.length === 0 ? '' : `<p class="refs">Точки решения: ${decisionRefs(diagram.decisions)}</p>`;
  return (
    `<section class="diagram" id="${anchor(diagram.id)}">` +
    `<h3>${escapeHtml(diagram.id)}. ${escapeHtml(diagram.title)}</h3>` +
    refs +
    `<pre class="mermaid">${escapeHtml(diagram.source)}</pre>` +
    '</section>'
  );
}

/**
 * Один самодостаточный HTML-файл: стили и бандл Mermaid встроены, сетевых
 * ссылок нет. `mermaidScript` обязателен, если в документе есть диаграммы.
 */
export function renderDesignHtml(document: DesignDocument, mermaidScript: string | undefined): string {
  if (document.diagrams.length > 0 && mermaidScript === undefined) {
    throw new BurnexError('Для документа с диаграммами нужен бандл Mermaid');
  }
  const notes = [notAgreedNote(document), changedNote(document)]
    .map((note, index) => (note === undefined ? '' : `<p class="note${index === 1 ? ' changed' : ''}">${escapeHtml(note)}</p>`))
    .join('');
  const sections: string[] = [
    `<h2>Context</h2><p>${escapeHtml(document.summary)}</p>`,
    `<h2>Decisions</h2>${document.decisions.map((decision) => decisionHtml(decision, document)).join('')}`,
  ];
  if (document.diagrams.length > 0) sections.push(`<h2>Diagrams</h2>${document.diagrams.map(diagramHtml).join('')}`);
  if (document.risks.length > 0) {
    sections.push(
      `<h2>Risks / Trade-offs</h2><ul>${document.risks
        .map((risk) => `<li><strong>${escapeHtml(risk.risk)}</strong> → ${escapeHtml(risk.mitigation)}</li>`)
        .join('')}</ul>`,
    );
  }
  if (document.open_questions.length > 0) {
    sections.push(`<h2>Open Questions</h2><ul>${document.open_questions.map((question) => `<li>${escapeHtml(question)}</li>`).join('')}</ul>`);
  }
  const scripts =
    document.diagrams.length > 0 && mermaidScript !== undefined
      ? `<script>${mermaidScript.replace(/<\/script/gi, '<\\/script')}</script><script>${MERMAID_BOOT}</script>`
      : '';
  return (
    '<!doctype html>\n' +
    '<html lang="ru">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<title>${escapeHtml(document.title)}</title>\n<style>${STYLE}</style>\n</head>\n<body>\n<main>\n` +
    `<h1>${escapeHtml(document.title)}</h1>\n${notes}\n${sections.join('\n')}\n</main>\n${scripts}\n</body>\n</html>\n`
  );
}

// ---------------------------------------------------------------------------
// OpenSpec design.md

/** Ограда кода длиннее самой длинной серии бэктиков в исходнике, не короче трёх. */
function fence(source: string): string {
  const longest = Math.max(0, ...[...source.matchAll(/`+/g)].map((match) => match[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Markdown с разделами шаблона OpenSpec design.md. */
export function renderDesignOpenSpec(document: DesignDocument): string {
  const lines: string[] = [`# ${document.title}`, ''];
  const notes = [notAgreedNote(document), changedNote(document)].filter((note): note is string => note !== undefined);
  if (notes.length > 0) {
    lines.push(...notes.map((note, index) => (index === 0 && document.agreed === false ? `> **${note}**` : `> ${note}`)), '');
  }
  lines.push('## Context', '', document.summary, '', '## Decisions', '');
  for (const decision of document.decisions) {
    lines.push(`### ${decision.id}. ${decision.question}`, '', `**Решение:** ${decision.choice}`, '', decision.rationale, '');
    if (decision.rejected.length > 0) {
      lines.push('**Отклонено:**', '');
      for (const item of decision.rejected) lines.push(`- ${item.summary} (${item.by}) — ${item.reason}`);
      lines.push('');
    }
  }
  if (document.diagrams.length > 0) {
    lines.push('## Diagrams', '');
    for (const diagram of document.diagrams) {
      const marker = fence(diagram.source);
      lines.push(`### ${diagram.id}. ${diagram.title}`, '');
      if (diagram.decisions.length > 0) lines.push(`Точки решения: ${diagram.decisions.join(', ')}.`, '');
      lines.push(`${marker}mermaid`, diagram.source.replace(/\n+$/, ''), marker, '');
    }
  }
  if (document.risks.length > 0) {
    lines.push('## Risks / Trade-offs', '');
    for (const risk of document.risks) lines.push(`- **[${risk.risk}]** → ${risk.mitigation}`);
    lines.push('');
  }
  if (document.open_questions.length > 0) {
    lines.push('## Open Questions', '');
    for (const question of document.open_questions) lines.push(`- ${question}`);
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}
