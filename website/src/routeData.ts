// Баннер предварительной версии на каждой странице — рукописной и
// синхронизированной: пока нет релизных тегов, сайт описывает main.
import { defineRouteMiddleware } from '@astrojs/starlight/route-data';
import { execFileSync } from 'node:child_process';
import { branch, repo } from '../pages.mjs';

const sha = (process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })).trim().slice(0, 7);
const ref = `<code>${branch}</code> (<a href="${repo}/commit/${sha}"><code>${sha}</code></a>)`;
const content: Record<string, string> = {
	en: `Preview built from ${ref}: describes behavior that is not released yet.`,
	ru: `Предварительная версия из ${ref}: описывает ещё не выпущенное поведение.`,
};

export const onRequest = defineRouteMiddleware((context) => {
	const { entry, locale } = context.locals.starlightRoute;
	entry.data.banner ??= { content: content[locale ?? 'en'] ?? content.en };
});
