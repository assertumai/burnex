// Проверяет WCAG-контраст ключевых пар обеих тем по токенам веб-UI —
// тем же, из которых sync-brand.mjs собирает тему сайта (src/styles/burnex.css).
// Правка палитры приложения, ломающая читаемость сайта, валит CI здесь.

import { readTokens } from './sync-brand.mjs';

/** [текст, фон, что это на сайте]; порог AA для обычного текста — 4.5. */
const pairs = [
	['foreground', 'background', 'основной текст'],
	['accent-foreground', 'background', 'ссылки'],
	['accent-foreground', 'accent', 'текст на акцентной подложке (активный пункт меню)'],
	['primary-foreground', 'primary', 'текст основной кнопки'],
	['muted-foreground', 'sidebar', 'вторичный текст в боковой колонке'],
	['muted-foreground', 'background', 'вторичный текст'],
	['foreground', 'card', 'текст карточки'],
];

const bad = [];
for (const [theme, tokens] of Object.entries(readTokens())) {
	for (const [fg, bg, what] of pairs) {
		const ratio = contrast(tokens.get(fg), tokens.get(bg));
		const line = `${theme}: ${what} --${fg} на --${bg} = ${ratio.toFixed(2)}`;
		if (ratio < 4.5) bad.push(line);
		else console.log(`ok  ${line}`);
	}
}
if (bad.length) {
	console.error(bad.map((l) => `bad ${l} < 4.5`).join('\n'));
	process.exit(1);
}

function contrast(a, b) {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

function luminance(hex) {
	let h = hex.replace('#', '');
	if (!/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(h)) throw new Error(`check-contrast: ожидался hex, получено ${hex}`);
	if (h.length === 3) h = [...h].map((c) => c + c).join('');
	return [0, 2, 4]
		.map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
		.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
		.reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
}
