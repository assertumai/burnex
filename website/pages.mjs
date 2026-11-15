// Состав сайта.
//
// Два языка: английский по умолчанию (/burnex/en/…) и русский (/burnex/ru/…).
// Рукописный слой (главная, Начало, Понятия, Руководства) лежит в Git прямо в
// src/content/docs/<язык>/ — на каждый язык свой перевод. Справочник —
// спецификация из docs/ как есть, по-русски: исходники остаются в docs/ (на них
// ссылаются сообщения lint и агенты), а scripts/sync-docs.mjs кладёт их в
// gitignored src/content/docs/<язык>/reference/ под обоими языками; английская
// копия помечена врезкой «только по-русски».
// Остальное в docs/ — внутренние записки, на сайт не попадает.

export const repo = 'https://github.com/assertumai/burnex';
export const branch = 'main';
export const base = '/burnex/';
/** Язык по умолчанию: на него ведёт корень /burnex/ и старые адреса. */
export const locale = 'en';
export const locales = {
	en: { label: 'English', lang: 'en' },
	ru: { label: 'Русский', lang: 'ru' },
};

/** Справочник: имя файла в docs/ без .md → страница <язык>/reference/<имя>. */
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

/**
 * Подписи справочника в боковой навигации: страницы по-русски на обоих языках,
 * но английское меню называет их по-английски (ru — заголовок «# …» в docs/).
 */
export const referenceLabels = {
	'pipeline-format': { en: 'Pipeline format', ru: 'Формат пайплайна' },
	config: { en: 'Configuration', ru: 'Конфигурация' },
	'run-layout': { en: 'Runs: state, worktree, resume', ru: 'Прогон: состояние, рабочее дерево, возобновление' },
	decisions: { en: 'Human decisions', ru: 'Решения человека' },
	plugins: { en: 'Plugins', ru: 'Плагины' },
	packages: { en: 'Packages', ru: 'Пакеты' },
	knowledge: { en: 'Repository knowledge', ru: 'Память репозитория' },
	install: { en: 'Install and update', ru: 'Установка и обновление' },
};

/** Таблица «исходник → slug сайта (с языком)» для синхронизации и ссылок. */
export const pages = Object.keys(locales).flatMap((lang) =>
	reference.map((name) => ({ source: `docs/${name}.md`, lang, slug: `${lang}/reference/${name}` })),
);

/** Рукописные разделы боковой навигации: slug без языка, подписи на обоих. */
export const sections = [
	{ label: 'Getting started', translations: { ru: 'Начало' }, items: ['start/first-run', 'start/how-it-works', 'start/examples'] },
	{
		label: 'Concepts',
		translations: { ru: 'Понятия' },
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
		label: 'Guides',
		translations: { ru: 'Руководства' },
		items: ['guides/fix-until-green', 'guides/second-opinion', 'guides/discussion', 'guides/backends', 'guides/from-stepcast'],
	},
];

/**
 * Адреса сайта этапа 1 (без языка): страница справочника — на новое место
 * на языке по умолчанию, снятая с сайта — на исходник в GitHub.
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
