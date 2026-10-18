import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

interface AssistantModalProps {
  onClose: () => void;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Reasoning streamed via a separate delta field, when the template parses it out. */
  thinking?: string;
}

/** One OpenAI-style streaming chunk, trimmed to the fields the modal reads. */
interface ChatChunk {
  choices?: { delta?: { content?: string; reasoning_content?: string } }[];
}

/**
 * Qwen3 reasons out loud before answering, as inline <think> tags in the
 * content (or the reasoning_content field, handled above). The reasoning is
 * worth watching while it streams, so it is split out rather than stripped:
 * the modal shows it dimmed until the first answer token, then it goes away.
 */
function splitThink(raw: string): { thinking: string; answer: string } {
  const start = raw.indexOf('<think>');
  if (start === -1) return { thinking: '', answer: raw };
  const end = raw.indexOf('</think>');
  if (end === -1) return { thinking: raw.slice(start + 7), answer: raw.slice(0, start) };
  return { thinking: raw.slice(start + 7, end), answer: raw.slice(0, start) + raw.slice(end + 8) };
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

  // In the home-screen app there is no browser chrome and the header sits in
  // the status-bar zone where taps are unreliable, so the OS back gesture
  // (left-edge swipe) must work as the way out: opening pushes one history
  // entry and popping it closes the chat. Closing any other way consumes the
  // entry again so the NEXT back gesture does not navigate the dashboard away.
  useEffect(() => {
    window.history.pushState({ assistant: true }, '');
    const onPop = () => onCloseRef.current();
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if ((window.history.state as { assistant?: boolean } | null)?.assistant) window.history.back();
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
        {messages.map((message, index) => {
          if (message.role === 'user') {
            return (
              <div key={index} className="assistant__msg assistant__msg--user">
                {message.content}
              </div>
            );
          }
          // The answer replaces the reasoning the moment its first token lands.
          const { thinking: inlineThinking, answer } = splitThink(message.content);
          const answerText = answer.replace(/^\s+/, '');
          const thinkingText = `${message.thinking ?? ''}${inlineThinking}`.trim();
          const streaming = busy && index === messages.length - 1;
          return (
            <div key={index} className="assistant__msg">
              {answerText ? (
                answerText
              ) : thinkingText && streaming ? (
                <span className="assistant__thinking">{thinkingText}</span>
              ) : streaming ? (
                <span className="assistant__pulse">· · ·</span>
              ) : (
                ''
              )}
            </div>
          );
        })}
        {error ? <p className="empty text-alert">{error}</p> : null}
      </div>
      <form
        className="assistant__composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <button
          type="button"
          className="assistant__close assistant__close--composer"
          onClick={onClose}
          aria-label="Close the chat"
        >
          ✕
        </button>
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
