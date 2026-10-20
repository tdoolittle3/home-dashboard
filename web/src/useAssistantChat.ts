import { useEffect, useRef, useState } from 'react';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Reasoning streamed via a separate delta field, when the template parses it out. */
  thinking?: string;
}

/** One OpenAI-style streaming chunk, trimmed to the fields the chat reads. */
interface ChatChunk {
  choices?: { delta?: { content?: string; reasoning_content?: string } }[];
}

/**
 * The assistant conversation, owned by App rather than the chat overlay so the
 * floating mic can speak into it whether or not the chat is on screen. Each
 * send posts the whole history to /api/chat (the server adds the system prompt
 * and the llama-swap key) and appends streamed deltas to a placeholder
 * assistant message, so tokens show up as the model produces them - including
 * the long first-token pause while llama-swap swaps a cold model in. reset()
 * is the "closing is a fresh conversation" half: it aborts any stream in
 * flight (the server propagates that upstream) and clears the history.
 */
export function useAssistantChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Leaving the page mid-reply aborts the fetch like reset() would.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function send(spoken: string) {
    const text = spoken.trim();
    if (!text || busy) return;
    setError(null);
    const history: ChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages([...history, { role: 'assistant', content: '' }]);
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const detail = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `the server returned ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;
          let content = '';
          let reasoning = '';
          try {
            const delta = (JSON.parse(data) as ChatChunk).choices?.[0]?.delta;
            content = delta?.content ?? '';
            reasoning = delta?.reasoning_content ?? '';
          } catch {
            // A keep-alive or a chunk split mid-line; the rest arrives next read.
          }
          if (content || reasoning) {
            setMessages((current) => {
              const last = current[current.length - 1];
              if (!last || last.role !== 'assistant') return current;
              return [
                ...current.slice(0, -1),
                {
                  role: 'assistant',
                  content: last.content + content,
                  thinking: (last.thinking ?? '') + reasoning,
                },
              ];
            });
          }
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err));
        // Drop the placeholder if nothing ever arrived, so a failed turn
        // leaves the user's message as the last thing said.
        setMessages((current) => {
          const last = current[current.length - 1];
          return last && last.role === 'assistant' && last.content === '' ? current.slice(0, -1) : current;
        });
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function reset() {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
  }

  return { messages, busy, error, send, reset };
}
