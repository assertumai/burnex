// Кладёт публичные страницы из docs/ и README.md в контент Starlight
// (src/content/docs — сгенерированный каталог, исключён из Git):
// заголовок из первого «# …», ссылка «редактировать» на исходник,
// баннер предварительной версии с SHA сборки.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { branch, pages, repo } from '../pages.mjs';

const website = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(website, '..');
const out = join(website, 'src/content/docs');

const sha = (process.env.GITHUB_SHA ?? git('rev-parse', 'HEAD')).slice(0, 7);
const banner =
	`Предварительная версия из <code>${branch}</code> (<a href="${repo}/commit/${sha}"><code>${sha}</code></a>): ` +
	'описывает ещё не выпущенное поведение.';

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
		'banner:',
		`  content: ${JSON.stringify(banner)}`,
		page.slug === '' ? 'tableOfContents: false' : null,
		'---',
	]
		.filter((line) => line !== null)
		.join('\n');
	writeFileSync(join(out, `${page.slug || 'index'}.md`), `${frontmatter}\n${body.replace(/^\s+/, '\n')}`);
}

console.log(`sync-docs: ${pages.length} страниц, ${sha}`);

function git(...args) {
	return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}
