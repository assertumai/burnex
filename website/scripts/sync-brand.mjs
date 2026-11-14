// Бренд сайта берётся из веб-UI burnex, а не копируется руками:
// - токены цветов из ui/src/styles.css (блок :root — светлая тема, блок
//   @media (prefers-color-scheme: dark) — тёмная) → src/styles/tokens.css
//   с :root[data-theme='light'|'dark'], потому что Starlight переключает тему
//   атрибутом, а не медиазапросом; имена получают префикс --bx-;
// - маскот (SVG со слоями .bx-eyes и .bx-crack) и favicon → src/assets/brand/ и public/.
// Пропавший токен или файл останавливает сборку. Всё, что пишет скрипт, — в .gitignore.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const website = join(dirname(fileURLToPath(import.meta.url)), '..');
const ui = join(website, '../ui/src');

/** Токены, на которые опирается тема сайта (burnex.css, check-contrast.mjs). */
export const required = [
	'background', 'foreground', 'card', 'popover', 'primary', 'primary-foreground',
	'secondary', 'muted', 'muted-foreground', 'accent', 'accent-foreground', 'border',
	'sidebar', 'status-running', 'status-success', 'status-failed',
	'participant-0', 'participant-1', 'participant-2', 'participant-3',
];

/** Токены светлой и тёмной темы из styles.css веб-UI. */
export function readTokens(css = readFileSync(join(ui, 'styles.css'), 'utf8')) {
	const light = block(css, /^:root\s*\{/m);
	const darkMedia = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{/.exec(css);
	if (!light || !darkMedia) fail('в ui/src/styles.css нет блока :root или тёмного @media-блока');
	const dark = block(css.slice(darkMedia.index + darkMedia[0].length - 1), /^\{/);
	const themes = { light: vars(light), dark: vars(dark) };
	for (const [theme, map] of Object.entries(themes)) {
		const missing = required.filter((name) => !map.has(name));
		if (missing.length) fail(`в теме ${theme} нет токенов: ${missing.map((n) => `--${n}`).join(', ')}`);
	}
	return themes;
}

function block(css, start) {
	const m = start.exec(css);
	if (!m) return null;
	const from = css.indexOf('{', m.index) + 1;
	const to = css.indexOf('}', from);
	return css.slice(from, to);
}

function vars(text) {
	const clean = text.replace(/\/\*[\s\S]*?\*\//g, '');
	return new Map([...clean.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

function fail(message) {
	console.error(`sync-brand: ${message}`);
	process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const themes = readTokens();
	const css = Object.entries(themes)
		.map(([theme, map]) => {
			const lines = [...map].map(([name, value]) => `\t--bx-${name}: ${value};`).join('\n');
			return `:root[data-theme='${theme}'] {\n${lines}\n}`;
		})
		.join('\n\n');
	mkdirSync(join(website, 'src/styles'), { recursive: true });
	writeFileSync(join(website, 'src/styles/tokens.css'), `/* Сгенерировано scripts/sync-brand.mjs из ui/src/styles.css — не править. */\n${css}\n`);

	mkdirSync(join(website, 'src/assets/brand'), { recursive: true });
	mkdirSync(join(website, 'public'), { recursive: true });
	copyFileSync(join(ui, 'assets/burnex-mark.svg'), join(website, 'src/assets/brand/burnex-mark.svg'));
	copyFileSync(join(ui, 'assets/burnex-mark.svg'), join(website, 'public/favicon.svg'));
	copyFileSync(join(ui, 'assets/burnex-mark.png'), join(website, 'public/apple-touch-icon.png'));
	copyFileSync(join(ui, 'assets/burnex-favicon.png'), join(website, 'public/favicon.png'));
	console.log(`sync-brand: токенов ${themes.light.size}/${themes.dark.size}, маскот и favicon`);
}
