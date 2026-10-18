import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

interface AssistantModalProps {
  onClose: () => void;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** One OpenAI-style streaming chunk, trimmed to the field the modal reads. */
interface ChatChunk {
  choices?: { delta?: { content?: string } }[];
}

/**
 * The full-screen chat overlay behind the topbar's agent button. History lives
 * here and only here - closing the modal is a fresh conversation, which suits
 * a wall dashboard better than a transcript that quietly grows forever. Each
 * send posts the whole history to /api/chat (the server adds the system prompt
 * and the llama-swap key) and appends streamed deltas to a placeholder
 * assistant message, so tokens show up as the model produces them - including
 * the long first-token pause while llama-swap swaps a cold model in.
 */
export function AssistantModal({ onClose }: AssistantModalProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The same body pin CameraViewer uses: position: fixed is the scroll lock
  // WebKit honours, the negative top stops the visual jump, and close restores
  // the scroll position.
  useEffect(() => {
    const { style } = document.body;
    const scrollY = window.scrollY;
    const original = {
      position: style.position,
      top: style.top,
      left: style.left,
      right: style.right,
      overflow: style.overflow,
    };
    style.position = 'fixed';
    style.top = `-${scrollY}px`;
    style.left = '0';
    style.right = '0';
    style.overflow = 'hidden';
    return () => {
      style.position = original.position;
      style.top = original.top;
      style.left = original.left;
      style.right = original.right;
      style.overflow = original.overflow;
      window.scrollTo(0, scrollY);
    };
  }, []);

  // Closing mid-reply aborts the fetch, which the server propagates upstream.
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
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
          let delta = '';
          try {
            delta = (JSON.parse(data) as ChatChunk).choices?.[0]?.delta?.content ?? '';
          } catch {
            // A keep-alive or a chunk split mid-line; the rest arrives next read.
          }
          if (delta) {
            setMessages((current) => {
              const last = current[current.length - 1];
              if (!last || last.role !== 'assistant') return current;
              return [...current.slice(0, -1), { role: 'assistant', content: last.content + delta }];
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

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="assistant" role="dialog" aria-modal="true" aria-label="Assistant chat">
      <header className="assistant__top">
        <h2>Assistant</h2>
        <button type="button" className="assistant__close" onClick={onClose} aria-label="Close the chat">
          ✕
        </button>
      </header>
      <div className="assistant__scroll" ref={scrollRef}>
        {messages.length === 0 ? (
          <p className="empty">Runs on Snibbly, right here on the LAN. A cold model takes a moment to load.</p>
        ) : null}
        {messages.map((message, index) => (
          <div
            key={index}
            className={message.role === 'user' ? 'assistant__msg assistant__msg--user' : 'assistant__msg'}
          >
            {message.content ||
              (busy && index === messages.length - 1 ? <span className="assistant__pulse">· · ·</span> : '')}
          </div>
        ))}
        {error ? <p className="empty text-alert">{error}</p> : null}
      </div>
      <form
        className="assistant__composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={inputRef}
          className="assistant__input"
          rows={1}
          value={draft}
          placeholder="Message…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="submit" className="toggle" disabled={busy || draft.trim().length === 0}>
          Send
        </button>
      </form>
    </div>
  );
}
