// Кладёт страницы справочника из docs/ в контент Starlight как есть, под
// каждый язык (src/content/docs/<язык>/reference — gitignored; очищаются только
// они, рукописные страницы рядом не трогаются): заголовок из первого «# …»,
// ссылка «редактировать» на исходник в docs/, оглавление до h2. Справочник
// пишется по-русски, поэтому в нерусских копиях первой строкой — врезка.

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { branch, locales, pages, repo } from '../pages.mjs';

const website = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(website, '..');
const content = join(website, 'src/content/docs');

const missing = pages.filter((p) => !existsSync(join(root, p.source)));
if (missing.length) {
	console.error(`sync-docs: нет исходников: ${missing.map((p) => p.source).join(', ')}`);
	process.exit(1);
}

for (const lang of Object.keys(locales)) {
	const out = join(content, lang, 'reference');
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
}

const russianOnly = [
	':::note[In Russian]',
	'The reference is the burnex specification, maintained in Russian next to the code',
	'([`docs/`](https://github.com/assertumai/burnex/tree/main/docs)); an English version will follow.',
	'The hand-written pages — Getting started, Concepts, Guides — are in English.',
	':::',
	'',
].join('\n');

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
	const note = page.lang === 'ru' ? '' : `\n${russianOnly}`;
	writeFileSync(join(content, `${page.slug}.md`), `${frontmatter}\n${note}${body.replace(/^\s+/, '\n')}`);
}

console.log(`sync-docs: справочник, ${pages.length} страниц на ${Object.keys(locales).length} языках`);
