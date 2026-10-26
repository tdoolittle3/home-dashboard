import { useState } from 'react';
import type { LlamaSwapState, LlamaSwapSummary, SourceResult } from '../types';

interface InferencePanelProps {
  title: string;
  result: SourceResult<LlamaSwapSummary> | null;
  /** llama.cpp's chat UI, from the panel's "chat" in dashboard.json - a /snibbly proxy path. */
  chatUrl?: string;
  /** llama-swap's own /ui/ dashboard, from the panel's "dashboard" - a /snibbly proxy path. */
  dashboardUrl?: string;
  /** Langfuse trace UI, from the panel's "langfuse" - an absolute link to snibbly's tailnet name. */
  langfuseUrl?: string;
}

const STATE_DOT: Record<LlamaSwapState, string> = {
  ready: 'up',
  starting: 'pending',
  stopping: 'pending',
  off: 'unknown',
};

const STATE_LABEL: Record<LlamaSwapState, string> = {
  ready: 'loaded',
  starting: 'starting',
  stopping: 'stopping',
  off: 'idle',
};

/**
 * The llama-swap panel, folded by default: the header is a toggle carrying the
 * at-a-glance read (status dot + how many models are loaded), the fold holds
 * the per-model rows and the way out to the full chat UI. It renders its own
 * header instead of using ServicePanel, which has no collapsed state and only
 * shows an aside once data arrives - here the dot and summary must show in all
 * three states. llama-swap loads a model when the first chat request names it,
 * so "idle" is the normal resting state, not a fault.
 */
export function InferencePanel({ title, result, chatUrl, dashboardUrl, langfuseUrl }: InferencePanelProps) {
  const [open, setOpen] = useState(false);

  const status = !result ? 'unknown' : result.ok ? 'up' : 'down';
  const summary = !result
    ? 'not configured'
    : result.ok
      ? `${result.data.loaded} of ${result.data.models.length} loaded`
      : 'unreachable';

  return (
    <section className="panel">
      <button type="button" className="panel__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="panel__heading">
          <span className={`dot dot--${status}`} aria-hidden="true" />
          {title}
        </span>
        <span className="panel__aside">
          {summary}
          <span className={open ? 'panel__chevron panel__chevron--open' : 'panel__chevron'} aria-hidden="true" />
        </span>
      </button>
      {open ? (
        <div className="panel__body">
          {!result ? (
            <p className="empty">
              Set LLAMA_SWAP_BASE_URL and LLAMA_SWAP_API_KEY in <code>.env</code> and restart to switch this panel
              on.
            </p>
          ) : !result.ok ? (
            <p className="empty text-alert">{result.error}</p>
          ) : result.data.models.length === 0 ? (
            <p className="empty">No models configured in llama-swap yet.</p>
          ) : (
            <ul className="rows rows--tight">
              {result.data.models.map((model) => (
                <li key={model.id} className="row">
                  <span className="row__label row__label--dotted">
                    <span className={`dot dot--${STATE_DOT[model.state]}`} aria-hidden="true" />
                    <span className="row__title">{model.name ?? model.id}</span>
                  </span>
                  <span className={model.state === 'off' ? 'row__value row__value--quiet' : 'row__value'}>
                    {STATE_LABEL[model.state]}
                  </span>
                  <span className="row__meta">{model.description ?? (model.name ? model.id : '')}</span>
                </li>
              ))}
            </ul>
          )}
          {chatUrl ? (
            <a className="panel__open" href={chatUrl} target="_blank" rel="noreferrer">
              Open the full chat UI ↗
            </a>
          ) : null}
          {dashboardUrl ? (
            <a className="panel__open" href={dashboardUrl} target="_blank" rel="noreferrer">
              llama-swap dashboard ↗
            </a>
          ) : null}
          {langfuseUrl ? (
            <a className="panel__open" href={langfuseUrl} target="_blank" rel="noreferrer">
              Langfuse traces ↗
            </a>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
