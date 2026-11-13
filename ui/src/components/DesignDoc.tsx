import type { JSX } from 'react';

import { Alert, AlertDescription, Badge } from '@burnex/ui';
import type { DesignDocument } from '../api';
import { MermaidDiagram } from './Mermaid';

/**
 * Итог шага `discuss` — проектный документ `burnex:design-doc`
 * (`render-design`, design.md, решение 8): пометка согласия, решения с
 * отклонёнными вариантами, диаграммы, риски и вопросы. Тот же документ
 * скачивается офлайн-HTML и OpenSpec `design.md` — ссылки даёт вызывающий.
 */
export function DesignDocView({
  document,
  downloads,
}: {
  readonly document: DesignDocument;
  readonly downloads?: { readonly html: string; readonly openspec: string } | undefined;
}): JSX.Element {
  const unresolved = new Set(document.unresolved ?? []);
  const changed = new Set(document.changed_by_aggregator ?? []);
  return (
    <article className="design-doc">
      <header className="design-doc-head">
        <h3>{document.title}</h3>
        {document.agreed === undefined ? null : (
          <Badge variant={document.agreed ? 'success' : 'destructive'}>{document.agreed ? 'agreed' : 'not agreed'}</Badge>
        )}
        {downloads === undefined ? null : (
          <span className="design-doc-downloads">
            <a href={downloads.html} download>
              HTML
            </a>
            <a href={downloads.openspec} download>
              design.md
            </a>
          </span>
        )}
      </header>
      {document.agreed === false ? (
        <Alert variant="destructive">
          <AlertDescription>
            The participants did not agree
            {unresolved.size === 0 ? '.' : ` on ${[...unresolved].join(', ')}.`}
          </AlertDescription>
        </Alert>
      ) : null}
      {changed.size === 0 ? null : <p className="kind">Changed by the aggregator: {[...changed].join(', ')}</p>}
      <p className="design-text">{document.summary}</p>

      <h4>Decisions</h4>
      <ol className="design-decisions">
        {document.decisions.map((decision) => (
          <li key={decision.id} id={`design-${decision.id}`} className="design-decision">
            <div className="design-decision-head">
              <span className="mono">{decision.id}</span> <b>{decision.question}</b>
              {changed.has(decision.id) ? <Badge variant="secondary">changed by aggregator</Badge> : null}
              {unresolved.has(decision.id) ? <Badge variant="destructive">unresolved</Badge> : null}
            </div>
            <p className="design-choice">{decision.choice}</p>
            <p className="design-text">{decision.rationale}</p>
            {decision.rejected.length === 0 ? null : (
              <details>
                <summary className="kind">Rejected ({decision.rejected.length})</summary>
                <ul>
                  {decision.rejected.map((item, index) => (
                    <li key={index}>
                      {item.summary} <span className="kind">({item.by})</span> — {item.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </li>
        ))}
      </ol>

      {document.diagrams.length === 0 ? null : (
        <>
          <h4>Diagrams</h4>
          {document.diagrams.map((diagram) => (
            <figure key={diagram.id} className="design-diagram">
              <figcaption>
                <span className="mono">{diagram.id}</span> {diagram.title}
                {diagram.decisions.length === 0 ? null : <span className="kind"> · {diagram.decisions.join(', ')}</span>}
              </figcaption>
              <MermaidDiagram source={diagram.source} title={diagram.title} />
            </figure>
          ))}
        </>
      )}

      {document.risks.length === 0 ? null : (
        <>
          <h4>Risks</h4>
          <ul className="design-list">
            {document.risks.map((risk, index) => (
              <li key={index}>
                <b>{risk.risk}</b> → {risk.mitigation}
              </li>
            ))}
          </ul>
        </>
      )}

      {document.open_questions.length === 0 ? null : (
        <>
          <h4>Open questions</h4>
          <ul className="design-list">
            {document.open_questions.map((question, index) => (
              <li key={index}>{question}</li>
            ))}
          </ul>
        </>
      )}
    </article>
  );
}
