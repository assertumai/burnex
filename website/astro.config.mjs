import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import mermaid from 'astro-mermaid';
import { repo, sections } from './pages.mjs';
import { remarkRepoLinks } from './scripts/remark-repo-links.mjs';

const base = '/burnex/';

export default defineConfig({
	site: 'https://assertumai.github.io',
	base,
	trailingSlash: 'always',
	markdown: {
		remarkPlugins: [[remarkRepoLinks, { base }]],
	},
	integrations: [
		// astro-mermaid должен идти до Starlight.
		mermaid({ theme: 'default', autoTheme: true }),
		starlight({
			title: 'Burnex',
			description: 'Движок пайплайнов для разработки с ИИ-агентами',
			defaultLocale: 'root',
			locales: { root: { label: 'Русский', lang: 'ru' } },
			social: [{ icon: 'github', label: 'GitHub', href: repo }],
			lastUpdated: false,
			sidebar: [
				{ label: 'Начало', link: '/' },
				...sections.map((s) => ({ label: s.label, items: s.pages })),
			],
		}),
	],
});
