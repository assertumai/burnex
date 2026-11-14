// Состав сайта.
//
// Рукописный слой (главная, Начало, Понятия, Руководства) лежит в Git прямо в
// src/content/docs/ru/. Справочник — спецификация из docs/ как есть: исходники
// остаются в docs/ (на них ссылаются сообщения lint и агенты), а
// scripts/sync-docs.mjs кладёт их в gitignored src/content/docs/ru/reference/.
// Остальное в docs/ — внутренние записки, на сайт не попадает.

export const repo = 'https://github.com/assertumai/burnex';
export const branch = 'main';
export const base = '/burnex/';
export const locale = 'ru';

/** Справочник: имя файла в docs/ без .md → страница ru/reference/<имя>. */
export const reference = [
	'pipeline-format',
	'config',
	'run-layout',
	'decisions',
	'plugins',
	'packages',
	'knowledge',
	'install',
];

/** Таблица «исходник → slug сайта (с локалью)» для синхронизации и ссылок. */
export const pages = reference.map((name) => ({ source: `docs/${name}.md`, slug: `${locale}/reference/${name}` }));

/** Рукописные разделы боковой навигации: slug без локали. */
export const sections = [
	{ label: 'Начало', items: ['start/first-run', 'start/how-it-works', 'start/examples'] },
	{
		label: 'Понятия',
		items: [
			'concepts/pipeline',
			'concepts/steps',
			'concepts/contracts',
			'concepts/retries-and-budgets',
			'concepts/agents',
			'concepts/context',
			'concepts/human',
			'concepts/runs',
		],
	},
	{
		label: 'Руководства',
		items: ['guides/fix-until-green', 'guides/second-opinion', 'guides/discussion', 'guides/backends', 'guides/from-stepcast'],
	},
];

/**
 * Адреса сайта до перехода на /ru/ (этап 1): страница справочника — на новое
 * место, снятая с сайта — на исходник в GitHub.
 */
export const legacy = {
	...Object.fromEntries(reference.map((name) => [`/${name}`, `${base}${locale}/reference/${name}/`])),
	...Object.fromEntries(
		['backlog', 'ui-plugins', 'widgets', 'routes', 'testing', 'release'].map((name) => [
			`/${name}`,
			`${repo}/blob/${branch}/docs/${name}.md`,
		]),
	),
};
