import type { LlamaSwapState, LlamaSwapSummary, SourceResult } from '../types';
import { ServicePanel } from './ServicePanel';

interface InferencePanelProps {
  title: string;
  result: SourceResult<LlamaSwapSummary> | null;
  /** Browser-facing URL of the llama-swap web UI, from the panel's "chat" in dashboard.json. */
  chatUrl?: string;
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
 * The llama-swap panel: which models the inference box has configured and
 * which of them hold VRAM right now. llama-swap loads a model when the first
 * chat request names it, so "idle" is the normal resting state, not a fault.
 */
export function InferencePanel({ title, result, chatUrl }: InferencePanelProps) {
  const chatLink = chatUrl ? (
    <a className="panel__open" href={chatUrl} target="_blank" rel="noreferrer">
      Open chat ↗
    </a>
  ) : null;

  return (
    <ServicePanel
      title={title}
      result={result}
      envKeys={['LLAMA_SWAP_BASE_URL', 'LLAMA_SWAP_API_KEY']}
      aside={(data) => (
        <>
          {data.loaded} of {data.models.length} loaded
          {chatLink}
        </>
      )}
    >
      {(data) =>
        data.models.length === 0 ? (
          <p className="empty">No models configured in llama-swap yet.</p>
        ) : (
          <ul className="rows rows--tight">
            {data.models.map((model) => (
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
        )
      }
    </ServicePanel>
  );
}
