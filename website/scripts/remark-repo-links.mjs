// Переписывает относительные ссылки и картинки страниц справочника, написанные
// для чтения на GitHub: на страницы из таблицы pages.mjs — в адреса сайта с
// локалью (якорь сохраняется), на прочие файлы репозитория — в
// github.com/…/blob/<ветка>/… (картинки — raw). Ссылка ведёт на страницу того
// же языка, что и страница, где она стоит. Абсолютные адреса, якоря и пути
// от корня сайта не трогает; код в блоках — не узлы link/image. Рукописные
// страницы (не из таблицы) не трогает: они ссылаются адресами сайта.

import { posix } from 'node:path';
import { visit } from 'unist-util-visit';
import { branch, pages, repo } from '../pages.mjs';

export function remarkRepoLinks({ base }) {
	const slugBySource = new Map(pages.map((p) => [`${p.lang}:${p.source}`, p.slug]));
	const pageBySlug = new Map(pages.map((p) => [p.slug, p]));
	const raw = repo.replace('https://github.com/', 'https://raw.githubusercontent.com/');

	return (tree, file) => {
		const path = (file.path ?? '').split(posix.sep).join('/');
		const at = path.lastIndexOf('/content/docs/');
		const slug = at < 0 ? '' : path.slice(at + '/content/docs/'.length).replace(/\.mdx?$/, '');
		const page = pageBySlug.get(slug);
		if (!page) return;
		const dir = posix.dirname(page.source);

		visit(tree, ['link', 'image', 'definition'], (node) => {
			const url = node.url;
			if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('#') || url.startsWith('/')) return;
			const [rel, hash = ''] = url.split('#');
			const target = posix.normalize(posix.join(dir, decodeURI(rel)));
			const anchor = hash ? `#${hash}` : '';
			const key = `${page.lang}:${target}`;
			if (slugBySource.has(key)) {
				node.url = `${base}${slugBySource.get(key)}/${anchor}`;
			} else if (node.type === 'image') {
				node.url = `${raw}/${branch}/${encodeURI(target)}`;
			} else {
				node.url = `${repo}/blob/${branch}/${encodeURI(target)}${anchor}`;
			}
		});
	};
}
