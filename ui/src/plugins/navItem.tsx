import type { JSX } from 'react';

import { IconValue } from '@burnex/ui';
import type { NavItemProps } from '@burnex/slots';

/**
 * Общий вид пункта меню — один компонент на все маршруты с объявленным
 * `nav` (design.md изменения `user-defined-routes`, Решение 13): каркас
 * (`shell.tsx`) рисует его как `default` слота `NAV`, ключ которого — `id`
 * маршрута, а не имя экрана.
 *
 * Экран, желающий свой вид пункта (счётчик), вносит вклад в тот же слот тем
 * же ключом и заменяет этот вид только для своего маршрута; подсветку он при
 * этом не пересчитывает сам — `active` уже пришёл каркасом, посчитанным по
 * `nav.active_for` действующего маршрута.
 *
 * В узкой колонке (`compact`) от пункта остаётся значок; подпись несёт
 * `aria-label`, а зрячему её показывает подсказка каркаса по `data-nav-tip`.
 */
export function GenericNavItem({ title, href, active, navigate, icon, compact = false }: NavItemProps): JSX.Element {
  const content = (
    <>
      <IconValue value={icon} label={title} />
      <span className="nav-item-label">{title}</span>
    </>
  );
  if (href === undefined) {
    // Маршрут объявил место в навигации, но собрать по нему ссылку нечем
    // (обязательный параметр пути не заполнен пустыми параметрами) — пункт
    // остаётся видимым названием, а не пропадает молча.
    return (
      <span className="nav-item nav-item-disabled" data-nav-tip={title}>
        {content}
      </span>
    );
  }
  return (
    <a
      className={active ? 'nav-item active' : 'nav-item'}
      href={href}
      aria-current={active ? 'page' : undefined}
      aria-label={compact ? title : undefined}
      data-nav-tip={title}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey) return;
        event.preventDefault();
        navigate(href);
      }}
    >
      {content}
    </a>
  );
}
