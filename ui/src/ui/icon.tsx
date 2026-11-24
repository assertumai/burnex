import { createElement, useState, type JSX } from 'react';

import { cn } from './utils';
import { ICON_NODES, type IconName } from './iconData';
import './icon.css';

export { ICON_NAMES, type IconName } from './iconData';

export function isIconName(value: string): value is IconName {
  return Object.hasOwn(ICON_NODES, value);
}

export interface IconProps {
  readonly name: IconName;
  /** Сторона значка в пикселях. */
  readonly size?: number;
  readonly className?: string | undefined;
}

/** Значок набора витрины: контур 24×24 цветом текста. Декоративен — имя действию даёт подпись или `aria-label` рядом. */
export function Icon({ name, size = 16, className }: IconProps): JSX.Element {
  return (
    <svg
      className={cn('sc-icon', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_NODES[name].map(([tag, attrs], index) => createElement(tag, { key: index, ...attrs }))}
    </svg>
  );
}

/** Префикс значка-текста: эмодзи либо пара символов. */
export const TEXT_ICON_PREFIX = 'text:';
/** Префикс значка-картинки. Рисуется только через `<img>`: SVG там не исполняет скриптов. */
export const IMAGE_ICON_PREFIX = 'data:image/';

/** Первые две графемы строки: эмодзи с модификаторами — одна графема, а не четыре символа UTF-16. */
export function iconGlyphs(text: string): string {
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text.trim())];
  return graphemes
    .slice(0, 2)
    .map((part) => part.segment)
    .join('');
}

export interface IconValueProps {
  /**
   * Значок пользователя одной строкой (docs/routes.md): имя набора,
   * `text:<символы>` либо `data:image/…`. Иное и отсутствующее значение дают
   * запасной значок — первую букву подписи.
   */
  readonly value: string | undefined;
  /** Подпись того, чему принадлежит значок, — из неё запасная буква. */
  readonly label: string;
  readonly size?: number;
  readonly className?: string | undefined;
}

/** Значок по строке настройки: один вид на меню, экран его настройки и выбор значка. */
export function IconValue({ value, label, size = 18, className }: IconValueProps): JSX.Element {
  // Картинка, которую браузер не смог показать, уступает место запасному значку.
  const [broken, setBroken] = useState<string | undefined>(undefined);
  if (value !== undefined && isIconName(value)) return <Icon name={value} size={size} className={className} />;
  if (value?.startsWith(IMAGE_ICON_PREFIX) === true && broken !== value) {
    return (
      <img
        className={cn('sc-icon-image', className)}
        src={value}
        alt=""
        width={size}
        height={size}
        onError={() => setBroken(value)}
      />
    );
  }
  const text = value?.startsWith(TEXT_ICON_PREFIX) === true ? iconGlyphs(value.slice(TEXT_ICON_PREFIX.length)) : '';
  return (
    <span
      className={cn('sc-icon-text', text === '' && 'sc-icon-text--fallback', className)}
      style={{ width: size, height: size, fontSize: size * (text === '' ? 0.6 : 0.8) }}
      aria-hidden="true"
    >
      {text === '' ? iconGlyphs(label).slice(0, 1).toUpperCase() : text}
    </span>
  );
}
