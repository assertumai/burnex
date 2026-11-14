// Баннер предварительной версии на каждой странице — рукописной и
// синхронизированной: пока нет релизных тегов, сайт описывает main.
import { defineRouteMiddleware } from '@astrojs/starlight/route-data';
import { execFileSync } from 'node:child_process';
import { branch, repo } from '../pages.mjs';

const sha = (process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })).trim().slice(0, 7);
const content =
	`Предварительная версия из <code>${branch}</code> (<a href="${repo}/commit/${sha}"><code>${sha}</code></a>): ` +
	'описывает ещё не выпущенное поведение.';

export const onRequest = defineRouteMiddleware((context) => {
	const { entry } = context.locals.starlightRoute;
	entry.data.banner ??= { content };
});
