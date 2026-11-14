// Проверяет собранный сайт: каждая внутренняя ссылка /burnex/… ведёт на
// существующую страницу, а якорь — на существующий id на ней; ссылка от корня
// домена мимо /burnex/ (например, редирект без базы) — ошибка.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = '/burnex/';
const dist = join(dirname(fileURLToPath(import.meta.url)), '../dist');
const html = readdirSync(dist, { recursive: true }).filter((f) => f.endsWith('.html'));
const ids = new Map();
const idsOf = (file) => {
	if (!ids.has(file)) {
		const text = readFileSync(file, 'utf8');
		ids.set(file, new Set([...text.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
	}
	return ids.get(file);
};

const broken = [];
for (const page of html) {
	const file = join(dist, page);
	for (const [, href] of readFileSync(file, 'utf8').matchAll(/href="([^"]+)"/g)) {
		if (href.startsWith('/') && !href.startsWith('//') && !href.startsWith(base)) {
			broken.push(`${page}: ссылка мимо базы ${base}: ${decodeURIComponent(href)}`);
			continue;
		}
		if (!href.startsWith(base) || href.startsWith(`${base}_astro/`)) continue;
		const [path, hash] = href.slice(base.length).split('#');
		if (/\.[a-z0-9]+$/i.test(path)) continue; // ресурсы: sitemap, favicon
		const target = join(dist, decodeURIComponent(path), 'index.html');
		if (!existsSync(target)) broken.push(`${page}: нет страницы ${href}`);
		else if (hash && !idsOf(target).has(decodeURIComponent(hash))) broken.push(`${page}: нет якоря ${decodeURIComponent(href)}`);
	}
}

if (broken.length) {
	console.error([...new Set(broken)].join('\n'));
	console.error(`check-links: битых ссылок ${new Set(broken).size}`);
	process.exit(1);
}
console.log(`check-links: ${html.length} страниц, ссылки целы (${relative(process.cwd(), dist)})`);
