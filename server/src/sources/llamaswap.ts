import { getJson } from './http.js';

/**
 * ready/starting/stopping are llama-swap's own words from /running; 'off' is
 * ours, for a configured model with no process behind it right now.
 */
export type LlamaSwapState = 'ready' | 'starting' | 'stopping' | 'off';

export interface LlamaSwapModel {
  id: string;
  /** The friendly name from llama-swap's config, when one is set. */
  name: string | null;
  description: string | null;
  state: LlamaSwapState;
}

export interface LlamaSwapSummary {
  /** Every configured model, loaded first, then starting/stopping, then off. */
  models: LlamaSwapModel[];
  /** How many are ready to answer right now. */
  loaded: number;
  /** How many are mid-swap (starting or stopping). */
  inFlight: number;
}

interface RawModel {
  id?: unknown;
  name?: unknown;
  description?: unknown;
}

interface RawModelList {
  data?: RawModel[];
}

interface RawRunning {
  running?: { model?: unknown; state?: unknown }[];
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const STATE_ORDER: Record<LlamaSwapState, number> = { ready: 0, starting: 1, stopping: 1, off: 2 };

/**
 * llama-swap gates everything except /health behind its `apiKeys` list, taken
 * as a Bearer token like any OpenAI-style client sends. /v1/models is the
 * configured catalogue; /running is which of them have a llama-server process
 * right now and in what state. Only reads - loading a model is a side effect
 * of chatting with it, and unloading stays in llama-swap's own UI.
 */
export function createLlamaSwapSource(baseUrl: string, apiKey: string) {
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };

  return async function fetchLlamaSwap(): Promise<LlamaSwapSummary> {
    // Since the langfuse capture deploy, LiteLLM fronts :8080 and passes the
    // OpenAI-style routes through to llama-swap but 404s its bespoke /running.
    // The catalogue answering is what "snibbly is up" means; per-model load
    // state is a bonus we only get when talking to llama-swap directly, so a
    // failed /running degrades every model to 'off' instead of sinking the tile.
    const [list, running] = await Promise.all([
      getJson<RawModelList>(`${baseUrl}/v1/models`, { headers }),
      getJson<RawRunning>(`${baseUrl}/running`, { headers }).catch(() => null),
    ]);

    const states = new Map<string, LlamaSwapState>();
    for (const entry of running?.running ?? []) {
      const model = toStringOrNull(entry.model);
      const state = toStringOrNull(entry.state);
      if (!model) continue;
      states.set(model, state === 'ready' || state === 'starting' || state === 'stopping' ? state : 'off');
    }

    const models: LlamaSwapModel[] = [];
    for (const raw of list.data ?? []) {
      const id = toStringOrNull(raw.id);
      if (!id) continue;
      // Through LiteLLM the catalogue is its openai/* wildcard expanded to a
      // couple hundred upstream model names that never run here - noise, not
      // inventory. Anything llama-swap itself serves has no such prefix.
      if (running === null && id.startsWith('openai/')) continue;
      models.push({
        id,
        name: toStringOrNull(raw.name),
        description: toStringOrNull(raw.description),
        state: states.get(id) ?? 'off',
      });
    }

    // A running model missing from the catalogue would be a llama-swap bug,
    // but losing it from the panel would hide the one model that is on.
    for (const [id, state] of states) {
      if (!models.some((model) => model.id === id)) {
        models.push({ id, name: null, description: null, state });
      }
    }

    models.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.id.localeCompare(b.id));

    return {
      models,
      loaded: models.filter((model) => model.state === 'ready').length,
      inFlight: models.filter((model) => model.state === 'starting' || model.state === 'stopping').length,
    };
  };
}
