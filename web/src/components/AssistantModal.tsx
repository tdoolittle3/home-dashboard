import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ChatMessage } from '../useAssistantChat';

interface AssistantModalProps {
  /** The dashboard title, so the chat's brand bar reads like the page it covers. */
  title: string;
  messages: ChatMessage[];
  busy: boolean;
  error: string | null;
  onSend: (text: string) => void;
  onClose: () => void;
}

/**
 * Qwen3 reasons out loud before answering, as inline <think> tags in the
 * content (or the reasoning_content field, which arrives already split). The
 * reasoning is worth watching while it streams, so it is split out rather than
 * stripped: the modal shows it dimmed until the first answer token, then it
 * goes away.
 */
function splitThink(raw: string): { thinking: string; answer: string } {
  const start = raw.indexOf('<think>');
  if (start === -1) return { thinking: '', answer: raw };
  const end = raw.indexOf('</think>');
  if (end === -1) return { thinking: raw.slice(start + 7), answer: raw.slice(0, start) };
  return { thinking: raw.slice(start + 7, end), answer: raw.slice(0, start) + raw.slice(end + 8) };
}

/**
 * The full-screen chat overlay behind the floating mic. The conversation
 * itself lives in useAssistantChat up in App - the mic speaks into it from
 * outside this overlay - and App resets it on close, so closing is still a
 * fresh conversation, which suits a wall dashboard better than a transcript
 * that quietly grows forever.
 */
export function AssistantModal({ title, messages, busy, error, onSend, onClose }: AssistantModalProps) {
  const [draft, setDraft] = useState('');
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

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  function submit() {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    onSend(text);
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  // The subheader names the conversation: the first thing asked, once there is
  // one. Its ✕ lives there rather than beside the brand because the brand row
  // shares the top of a home-screen app with the status bar, where iOS
  // quietly ignores taps - one row further down, taps land.
  const firstUser = messages.find((message) => message.role === 'user');
  const chatTitle = firstUser
    ? firstUser.content.length > 48
      ? `${firstUser.content.slice(0, 48).trimEnd()}…`
      : firstUser.content
    : 'New chat';

  return (
    <div className="assistant" role="dialog" aria-modal="true" aria-label="Assistant chat">
      <header className="assistant__brand">
        <h1>{title}</h1>
      </header>
      <div className="assistant__sub">
        <span className="assistant__subtitle">{chatTitle}</span>
        <button type="button" className="assistant__close" onClick={onClose} aria-label="Close the chat">
          ✕
        </button>
      </div>
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
          submit();
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
