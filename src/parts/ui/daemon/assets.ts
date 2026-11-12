import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Страница витрины.
 *
 * Собирается Vite в один самодостаточный файл со встроенными скриптами и
 * стилями, поэтому здесь она остаётся единственным артефактом. Свойство
 * «демон не становится файловым сервером» этот файл больше не держит целиком:
 * спайк `ui-runtime-widget-spike` завёл вторую отдачу содержимого — виджеты
 * пользователя под `/widgets/` (`src/parts/ui/daemon/server.ts`), с разбором MIME
 * (`text/javascript`, фиксированным) и защитой от обхода путей, проверенной
 * тестом. Граница, которая осталась: демон не выводит путь файла из
 * произвольного запроса — обе формы адреса объявлены, третьей нет.
 *
 * Читается с диска при первом запросе и остаётся в памяти: страница неизменна
 * в пределах запуска демона, а перечитывать её на каждое обращение — платить
 * за неизменное.
 */

/** Собранная витрина рядом с скомпилированным кодом: `dist/ui-web/index.html`. */
export function dashboardPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'ui-web', 'index.html');
}

/**
 * Кеш по файлу, а не одна ячейка: демон в пределах запуска читает одну и ту же
 * страницу, но проверки поднимают серверы с разными файлами витрины, и общая
 * ячейка выдавала бы одному из них чужую разметку.
 */
const cached = new Map<string, DashboardPage>();

/**
 * Имя `<meta>`, которым страница несёт отпечаток своей сборки. Та же строка
 * читается каркасом витрины (`ui/src/plugins/shell.tsx`): вкладка, открытая
 * до перезапуска демона на другой сборке, сравнивает свой отпечаток с
 * событием `build` потока и предлагает перезагрузку — иначе новые маршруты и
 * экраны приходят ей потоком, а их браузерных половин в её бандле нет.
 */
export const BUILD_META = 'burnex-build';

export interface DashboardPage {
  /** Разметка с `<meta name="burnex-build">` в `<head>`. */
  readonly html: string;
  /** Отпечаток собранного файла: первые 16 знаков sha256 его содержимого. */
  readonly build: string;
}

/**
 * Разметка витрины. `undefined` — витрина не собрана: единственный внятный
 * ответ на это — сказать, какой командой её собрать, а не отдать пустую
 * страницу и оставить пользователя гадать.
 */
export function dashboardPage(file: string = dashboardPath()): DashboardPage | undefined {
  const hit = cached.get(file);
  if (hit !== undefined) return hit;
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const build = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const meta = `<meta name="${BUILD_META}" content="${build}">`;
  // В `<head>`, а без него — сразу за `<!doctype>`: разметка до него
  // перевела бы страницу в режим совместимости.
  const anchor = /<head[^>]*>/i.exec(source) ?? /<!doctype[^>]*>/i.exec(source);
  const at = anchor === null ? 0 : anchor.index + anchor[0].length;
  const html = `${source.slice(0, at)}${meta}${source.slice(at)}`;
  const page = { html, build };
  cached.set(file, page);
  return page;
}
