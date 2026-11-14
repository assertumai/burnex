// Переписывает относительные ссылки и картинки, написанные для чтения на GitHub:
// на опубликованные страницы — в адреса сайта (якорь сохраняется),
// на прочие файлы репозитория — в github.com/…/blob/<ветка>/… (картинки — raw).
// Абсолютные адреса, якоря и пути от корня сайта не трогает; код в блоках —
// не узлы link/image, поэтому не затрагивается.

import { posix } from 'node:path';
import { visit } from 'unist-util-visit';
import { branch, pages, repo } from '../pages.mjs';

export function remarkRepoLinks({ base }) {
	const slugBySource = new Map(pages.map((p) => [p.source, p.slug]));
	const sourceBySlug = new Map(pages.map((p) => [p.slug || 'index', p.source]));
	const raw = repo.replace('https://github.com/', 'https://raw.githubusercontent.com/');

	return (tree, file) => {
		const name = posix.basename(file.path ?? '', '.md');
		const source = sourceBySlug.get(name);
		if (!source) return;
		const dir = posix.dirname(source);

		visit(tree, ['link', 'image', 'definition'], (node) => {
			const url = node.url;
			if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('#') || url.startsWith('/')) return;
			const [path, hash = ''] = url.split('#');
			const target = posix.normalize(posix.join(dir, decodeURI(path)));
			const anchor = hash ? `#${hash}` : '';
			if (slugBySource.has(target)) {
				const slug = slugBySource.get(target);
				node.url = `${base}${slug ? `${slug}/` : ''}${anchor}`;
			} else if (node.type === 'image') {
				node.url = `${raw}/${branch}/${encodeURI(target)}`;
			} else {
				node.url = `${repo}/blob/${branch}/${encodeURI(target)}${anchor}`;
			}
		});
	};
}
