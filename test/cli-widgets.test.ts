import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ExitCode } from '../src/kernel/errors.js';
import { runWidgetsCommand } from '../src/parts/ui/commands/widgets.js';
import { SHARED_MODULE_TABLE_VERSION } from '../src/parts/ui/daemon/sharedModules.js';
import { tempDir } from './tmp.js';

function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

function project(): string {
  const dir = tempDir('cli-widgets-');
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

describe('cli widgets: состав виджетов проекта', () => {
  it('печатает оба виджета, называя у устаревшего неразрешимое имя и версию таблицы', () => {
    const dir = project();
    const widgetsDir = join(dir, '.stepcast', 'widgets');
    mkdirSync(widgetsDir, { recursive: true });
    writeFileSync(join(widgetsDir, 'clock.tsx'), "import { useState } from 'react';\nexport default function C() { return null; }\n");
    writeFileSync(
      join(widgetsDir, 'gauge.tsx'),
      "import { NotAName } from '@stepcast/ui';\nexport default function G() { return null; }\n",
    );

    const { lines, write } = capture();
    const code = runWidgetsCommand({ command: 'widgets', positional: [], flags: {} }, write, dir);
    assert.equal(code, ExitCode.ok);

    const text = lines.join('\n');
    assert.match(text, /clock/);
    assert.match(text, /gauge/);
    assert.match(text, /NotAName/);
    assert.match(text, new RegExp(String(SHARED_MODULE_TABLE_VERSION)));
  });

  it('--json печатает тот же состав машинным видом', () => {
    const dir = project();
    const widgetsDir = join(dir, '.stepcast', 'widgets');
    mkdirSync(widgetsDir, { recursive: true });
    writeFileSync(join(widgetsDir, 'clock.tsx'), "import { NotAName } from '@stepcast/ui';\nexport default function C() { return null; }\n");

    const { lines, write } = capture();
    const code = runWidgetsCommand({ command: 'widgets', positional: [], flags: { json: true } }, write, dir);
    assert.equal(code, ExitCode.ok);

    const parsed = JSON.parse(lines.join('\n')) as {
      readonly widgets: readonly {
        readonly id: string;
        readonly unresolved: readonly { readonly kind: string; readonly name: string }[];
      }[];
      readonly tableVersion: number;
    };
    assert.equal(parsed.widgets.length, 1);
    assert.equal(parsed.widgets[0]?.id, 'clock');
    assert.equal(parsed.widgets[0]?.unresolved[0]?.kind, 'name');
    assert.equal(parsed.widgets[0]?.unresolved[0]?.name, 'NotAName');
    assert.equal(parsed.tableVersion, SHARED_MODULE_TABLE_VERSION);
  });

  /**
   * Уход специфика целиком обязан попадать в состав так же, как уход имени:
   * иначе самый вероятный вид смены таблицы не дал бы ни строки в команде, ни
   * кнопки в витрине (`widget-migration`, «Команда печатает состав виджетов
   * проекта и их разрешимость»).
   */
  it('специфик вне таблицы назван неразрешимым и в тексте, и в машинном виде', () => {
    const dir = project();
    const widgetsDir = join(dir, '.stepcast', 'widgets');
    mkdirSync(widgetsDir, { recursive: true });
    writeFileSync(
      join(widgetsDir, 'gauge.tsx'),
      "import { Gauge } from 'gone-module';\nexport default function G() { return null; }\n",
    );

    const text = capture();
    assert.equal(runWidgetsCommand({ command: 'widgets', positional: [], flags: {} }, text.write, dir), ExitCode.ok);
    assert.match(text.lines.join('\n'), /устарел: gone-module/);

    const json = capture();
    runWidgetsCommand({ command: 'widgets', positional: [], flags: { json: true } }, json.write, dir);
    const parsed = JSON.parse(json.lines.join('\n')) as {
      readonly widgets: readonly { readonly unresolved: readonly { readonly kind: string; readonly name: string }[] }[];
    };
    assert.deepEqual(parsed.widgets[0]?.unresolved, [
      { kind: 'specifier', specifier: 'gone-module', name: 'gone-module' },
    ]);
  });

  it('виджет пакета назван с источником, виджет в конфликте двух пакетов — с причиной, а не пропадает', () => {
    const dir = project();
    const home = tempDir('cli-widgets-home-');
    const writePackageWidget = (name: string, id: string): void => {
      const packageDir = join(dir, '.stepcast', 'packages', name);
      mkdirSync(join(packageDir, 'widgets'), { recursive: true });
      writeFileSync(
        join(packageDir, 'package.yml'),
        `version: 1\nkind: package\nname: ${name}\ndescription: Пример\npackage_version: 0.1.0\n`,
      );
      writeFileSync(join(packageDir, 'widgets', `${id}.tsx`), 'export default function W() { return null; }\n');
    };
    writePackageWidget('hello', 'clock');
    writePackageWidget('a', 'gauge');
    writePackageWidget('b', 'gauge');

    const text = capture();
    assert.equal(runWidgetsCommand({ command: 'widgets', positional: [], flags: {} }, text.write, dir, { home }), ExitCode.ok);
    const printed = text.lines.join('\n');
    assert.match(printed, /clock .*\[package hello \(project\)\]/);
    assert.match(printed, /gauge .*ошибка: .*a and b/);

    const json = capture();
    runWidgetsCommand({ command: 'widgets', positional: [], flags: { json: true } }, json.write, dir, { home });
    const parsed = JSON.parse(json.lines.join('\n')) as {
      readonly widgets: readonly { readonly id: string; readonly source: unknown; readonly error?: string }[];
    };
    assert.deepEqual(parsed.widgets.find((widget) => widget.id === 'clock')?.source, { layer: 'project', package: 'hello' });
    assert.match(parsed.widgets.find((widget) => widget.id === 'gauge')?.error ?? '', /a and b/);
  });

  it('проект без каталога виджетов — пустой состав, код возврата 0', () => {
    const dir = project();
    const { lines, write } = capture();
    const code = runWidgetsCommand({ command: 'widgets', positional: [], flags: {} }, write, dir);
    assert.equal(code, ExitCode.ok);
    assert.match(lines.join('\n'), /виджетов нет/);
  });
});
