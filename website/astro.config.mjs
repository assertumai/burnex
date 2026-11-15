import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import mermaid from 'astro-mermaid';
import { base, branch, legacy, locale, locales, reference, referenceLabels, repo, sections } from './pages.mjs';
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
			description: 'Deterministic pipelines for AI agents: a YAML pipeline where code, people and agents each do their own part.',
			logo: { src: './src/assets/brand/burnex-mark.svg', alt: '' },
			favicon: '/favicon.svg',
			head: [
				// PNG — запасной значок для браузеров без SVG-favicon.
				{ tag: 'link', attrs: { rel: 'icon', type: 'image/png', href: `${base}favicon.png` } },
				{ tag: 'link', attrs: { rel: 'apple-touch-icon', href: `${base}apple-touch-icon.png` } },
			],
			// Явные языки без корневого: /burnex/en/… (по умолчанию) и /burnex/ru/…;
			// переключатель стоит в шапке сразу за значком GitHub (burnex.css).
			defaultLocale: locale,
			locales,
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
				...sections,
				{
					label: 'Reference',
					translations: { ru: 'Справочник' },
					collapsed: true,
					items: reference.map((name) => ({
						slug: `reference/${name}`,
						label: referenceLabels[name].en,
						translations: { ru: referenceLabels[name].ru },
					})),
				},
			],
		}),
	],
});
