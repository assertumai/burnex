import type { JSX, ReactNode } from 'react';

function plainUrl(text: string): string {
  let url = text.replace(/[.,;!?]+$/, '');
  for (const [open, close] of [['(', ')'], ['[', ']']] as const) {
    while (url.endsWith(close) && url.split(close).length > url.split(open).length) url = url.slice(0, -1);
  }
  return url;
}

/** Small text format: links and line breaks, no HTML execution. */
export function RunPublication({ text }: { readonly text: string | undefined }): JSX.Element {
  if (text === undefined || text === '') return <span className="dim">—</span>;
  const parts: ReactNode[] = [];
  const links = /\[([^\]\n]+)\]\(((?:[^\s()]|\([^\s()]*\))+)\)|https?:\/\/[^\s<>]+/g;
  let offset = 0;
  for (const match of text.matchAll(links)) {
    const start = match.index;
    parts.push(text.slice(offset, start));
    const raw = match[0];
    const href = match[2] ?? plainUrl(raw);
    // HTTP(S) or root-relative dashboard routes; no protocol-relative URLs or backslashes.
    const safe = /^(https?:\/\/|\/(?!\/))/i.test(href) && !/[\\\u0000-\u0020]/.test(href);
    if (safe) {
      parts.push(<a key={start} href={href} target="_blank" rel="noopener noreferrer">{match[1] ?? href}</a>);
      if (match[2] === undefined) parts.push(raw.slice(href.length));
    } else parts.push(raw);
    offset = start + raw.length;
  }
  parts.push(text.slice(offset));
  return <div className="run-publication">{parts}</div>;
}
