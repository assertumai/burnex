import { useEffect, useId, useState, type JSX } from 'react';
import type { Mermaid } from 'mermaid';

/**
 * Диаграмма Mermaid в витрине (`render-design`, design.md, решение 8).
 *
 * Витрина собирается одной страницей (`vite-plugin-singlefile`), и
 * динамический `import('mermaid')` встроился бы в неё целиком (+5 МБ).
 * Поэтому бандл грузится лениво тегом `<script>` с демона
 * (`GET /api/vendor/mermaid.js`) — тот же файл, что встраивает офлайн-HTML
 * `burnex render design`, — и только когда на экране есть диаграмма.
 *
 * `securityLevel: 'strict'` — Mermaid сам чистит SVG и не исполняет ссылки и
 * HTML из исходника. Пока бандл грузится, а также при ошибке разбора,
 * показывается исходник; при ошибке — ещё и её текст.
 */

export const MERMAID_BUNDLE_URL = '/api/vendor/mermaid.js';

let loader: Promise<Mermaid> | undefined;

function loadMermaid(): Promise<Mermaid> {
  loader ??= new Promise<Mermaid>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = MERMAID_BUNDLE_URL;
    script.async = true;
    script.onload = () => {
      const mermaid = (globalThis as { mermaid?: Mermaid }).mermaid;
      if (mermaid === undefined) reject(new Error('the Mermaid bundle did not register itself'));
      else resolve(mermaid);
    };
    script.onerror = () => reject(new Error('the Mermaid bundle could not be loaded'));
    document.head.append(script);
  }).then(
    (mermaid) => {
      const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
      return mermaid;
    },
    (failure: unknown) => {
      // Следующая диаграмма попробует снова: демон мог быть недоступен миг.
      loader = undefined;
      throw failure;
    },
  );
  return loader;
}

export function MermaidDiagram({ source, title }: { readonly source: string; readonly title?: string }): JSX.Element {
  const id = `mermaid-${useId().replace(/[^A-Za-z0-9]/g, '')}`;
  const [svg, setSvg] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setSvg(undefined);
    setError(undefined);
    loadMermaid()
      .then((mermaid) => mermaid.render(id, source))
      .then((result) => {
        if (alive) setSvg(result.svg);
      })
      .catch((failure: unknown) => {
        if (alive) setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => {
      alive = false;
    };
  }, [id, source]);

  if (svg !== undefined) {
    // SVG собран Mermaid со `securityLevel: 'strict'` и им же очищен.
    return <div className="mermaid-diagram" role="img" aria-label={title ?? 'Diagram'} dangerouslySetInnerHTML={{ __html: svg }} />;
  }
  return (
    <div className="mermaid-fallback">
      <pre className="mermaid-source">{source}</pre>
      {error === undefined ? null : <p className="mermaid-error">Diagram could not be rendered: {error}</p>}
    </div>
  );
}
