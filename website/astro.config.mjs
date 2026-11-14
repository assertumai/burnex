import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import mermaid from 'astro-mermaid';
import { base, branch, legacy, locale, reference, repo, sections } from './pages.mjs';
import { remarkRepoLinks } from './scripts/remark-repo-links.mjs';

export default defineConfig({
	site: 'https://assertumai.github.io',
	base,
	trailingSlash: 'always',
	redirects: legacy,
	// Главная импортирует examples/home/burnex.yml из корня репозитория.
	vite: { server: { fs: { allow: ['..'] } } },
	markdown: {
		remarkPlugins: [[remarkRepoLinks, { base }]],
	},
	integrations: [
		// astro-mermaid должен идти до Starlight. Тема default/dark переключается
		// по data-theme; цвета узлов подтягиваются к бренду в burnex.css.
		mermaid({ theme: 'default', autoTheme: true }),
		starlight({
			title: 'Burnex',
			description: 'Агентская разработка — по рельсам: YAML-пайплайн, где код, человек и агенты делают каждый своё.',
			logo: { src: './src/assets/brand/burnex-mark.png', alt: '' },
			favicon: '/favicon.png',
			head: [{ tag: 'link', attrs: { rel: 'apple-touch-icon', href: `${base}apple-touch-icon.png` } }],
			// Явные локали без корневой: адреса /burnex/ru/… не придётся менять,
			// когда появится английский (/burnex/en/…) и корень поведёт на него.
			defaultLocale: locale,
			locales: { ru: { label: 'Русский', lang: 'ru' } },
			social: [{ icon: 'github', label: 'GitHub', href: repo }],
			editLink: { baseUrl: `${repo}/edit/${branch}/website/` },
			lastUpdated: false,
			disable404Route: true,
			routeMiddleware: './src/routeData.ts',
			customCss: [
				'@fontsource/ibm-plex-sans/400.css',
				'@fontsource/ibm-plex-sans/600.css',
				'@fontsource/ibm-plex-sans/700.css',
				'@fontsource/ibm-plex-mono/400.css',
				'@fontsource/ibm-plex-mono/500.css',
				'./src/styles/tokens.css',
				'./src/styles/burnex.css',
			],
			expressiveCode: {
				styleOverrides: {
					codeFontFamily: "'IBM Plex Mono', ui-monospace, monospace",
					borderRadius: '10px',
					borderColor: 'var(--bx-border)',
					codeBackground: 'var(--sl-color-gray-6)',
					frames: { editorTabBarBackground: 'var(--bx-sidebar)', terminalTitlebarBackground: 'var(--bx-sidebar)' },
				},
			},
			sidebar: [
				...sections.map((s) => ({ label: s.label, items: s.items })),
				{ label: 'Справочник', collapsed: true, items: reference.map((name) => `reference/${name}`) },
			],
		}),
	],
});
