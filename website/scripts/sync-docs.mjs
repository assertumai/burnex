// Кладёт страницы справочника из docs/ в контент Starlight как есть
// (src/content/docs/ru/reference — gitignored; очищается только он,
// рукописные страницы рядом не трогаются): заголовок из первого «# …»,
// ссылка «редактировать» на исходник в docs/, оглавление до h2.

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { branch, locale, pages, repo } from '../pages.mjs';

const website = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(website, '..');
const content = join(website, 'src/content/docs');
const out = join(content, locale, 'reference');

const missing = pages.filter((p) => !existsSync(join(root, p.source)));
if (missing.length) {
	console.error(`sync-docs: нет исходников: ${missing.map((p) => p.source).join(', ')}`);
	process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const page of pages) {
	const text = readFileSync(join(root, page.source), 'utf8');
	const heading = /^# +(.+?)\s*$/m.exec(text);
	if (!heading) {
		console.error(`sync-docs: в ${page.source} нет заголовка первого уровня`);
		process.exit(1);
	}
	const body = text.slice(0, heading.index) + text.slice(heading.index + heading[0].length);
	const frontmatter = [
		'---',
		`title: ${JSON.stringify(heading[1])}`,
		`editUrl: ${JSON.stringify(`${repo}/edit/${branch}/${page.source}`)}`,
		'tableOfContents: { maxHeadingLevel: 2 }',
		'---',
	].join('\n');
	writeFileSync(join(content, `${page.slug}.md`), `${frontmatter}\n${body.replace(/^\s+/, '\n')}`);
}

console.log(`sync-docs: справочник, ${pages.length} страниц`);
