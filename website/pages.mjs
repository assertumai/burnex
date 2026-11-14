// Публичные страницы сайта. Исходники остаются в docs/ (на них ссылаются
// сообщения lint и агенты); scripts/sync-docs.mjs кладёт их в контент Starlight.
// Чего здесь нет — внутренние записки, на сайт не попадают.

export const repo = 'https://github.com/assertumai/burnex';
export const branch = 'main';

/** Главная — README.md из корня репозитория. */
export const home = { slug: '', source: 'README.md' };

/** Разделы боковой навигации; slug страницы = имя файла в docs/ без .md. */
export const sections = [
	{ label: 'Формат и конфигурация', pages: ['pipeline-format', 'config'] },
	{ label: 'Прогоны', pages: ['run-layout', 'decisions', 'backlog', 'knowledge'] },
	{ label: 'Расширения', pages: ['plugins', 'packages', 'ui-plugins', 'widgets', 'routes'] },
	{ label: 'Для контрибьюторов', pages: ['testing', 'release'] },
];

/** Все страницы: путь исходника от корня репозитория → slug на сайте. */
export const pages = [
	home,
	...sections.flatMap((s) => s.pages.map((slug) => ({ slug, source: `docs/${slug}.md` }))),
];
