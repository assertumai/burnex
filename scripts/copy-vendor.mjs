// Кладёт в dist/vendor/ сторонние файлы, которые движок встраивает в свои
// артефакты: бандл Mermaid для офлайн-HTML `burnex render design`
// (render-design, design.md, решение 3). Mermaid — devDependency: в релиз и
// пакет он едет файлом в dist/, а не зависимостью движка.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const mermaidDir = dirname(require.resolve('mermaid/package.json'));
const target = join(root, 'dist', 'vendor');

mkdirSync(target, { recursive: true });
copyFileSync(join(mermaidDir, 'dist', 'mermaid.min.js'), join(target, 'mermaid.min.js'));
