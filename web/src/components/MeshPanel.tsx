import { useEffect, useRef, useState, type FormEvent } from 'react';
import { sendMeshText } from '../api';
import { formatEventTime, formatRelative } from '../format';
import type { MeshMessage, MeshNode, MeshSummary } from '../types';
import { Panel } from './Panel';

interface MeshPanelProps {
  title: string;
  mesh: MeshSummary | null;
  maxMessages?: number;
}

/** Bytes, not chars - the server enforces the same bound on the LoRa payload. */
const TEXT_MAX_BYTES = 200;

function nameFor(message: MeshMessage, nodes: Map<number, MeshNode>): string {
  if (message.viaDashboard) return 'Dashboard';
  const node = nodes.get(message.from);
  return node?.shortName ?? node?.longName ?? node?.id ?? `#${message.from}`;
}

function nodeLabel(node: MeshNode): string {
  return node.longName ?? node.shortName ?? node.id ?? `#${node.num}`;
}

function nodeMeta(node: MeshNode): string {
  const parts: string[] = [];
  if (node.batteryLevel !== null) parts.push(`${Math.round(node.batteryLevel)}%`);
  if (node.snr !== null) parts.push(`${node.snr.toFixed(1)} dB`);
  return parts.join(' · ');
}

function lastHeard(node: MeshNode): string {
  return node.lastHeard > 0 ? formatRelative(new Date(node.lastHeard * 1000).toISOString()) : '';
}

export function MeshPanel({ title, mesh, maxMessages = 20 }: MeshPanelProps) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const feedRef = useRef<HTMLUListElement>(null);
  const messageCount = mesh?.messages.length ?? 0;

  // Keep the feed pinned to the newest message; it reads bottom-up like chat.
  useEffect(() => {
    const feed = feedRef.current;
    if (feed) feed.scrollTop = feed.scrollHeight;
  }, [messageCount]);

  if (!mesh) {
    return (
      <Panel title={title} aside="not configured">
        <p className="empty">
          Set MESH_MQTT_URL and MESH_CHANNEL in <code>.env</code> and restart to switch this panel on.
        </p>
      </Panel>
    );
  }

  const { status, channel, canSend } = mesh;
  const nodes = new Map(mesh.nodes.map((node) => [node.num, node]));
  const messages = mesh.messages.slice(-maxMessages);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const text = draft.trim();
    if (text.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await sendMeshText(text);
      // 202 means the broker took it; the echoed message rides the stream.
      setDraft('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const gatewayState =
    status.gatewayOnline === null ? 'unknown' : status.gatewayOnline ? 'up' : 'down';

  return (
    <Panel
      title={title}
      aside={
        <span className="checks">
          <span className="checks__item">
            <span className={status.connected ? 'dot dot--up' : 'dot dot--down'} aria-hidden="true" />
            broker
          </span>
          <span className="checks__item">
            <span className={`dot dot--${gatewayState}`} aria-hidden="true" />
            gateway
          </span>
        </span>
      }
    >
      {messages.length === 0 ? (
        <p className="empty">
          Nothing heard on <code>{channel}</code> yet. Messages appear here as nodes talk.
        </p>
      ) : (
        <ul className="mesh__feed" ref={feedRef}>
          {messages.map((message) => (
            <li
              key={message.id}
              className={message.viaDashboard ? 'mesh__msg mesh__msg--self' : 'mesh__msg'}
            >
              <span className="mesh__msg-meta">
                <span className="mesh__msg-sender">{nameFor(message, nodes)}</span>
                <span className="mesh__msg-time">{formatEventTime(message.timestamp)}</span>
              </span>
              <span className="mesh__msg-text">{message.text}</span>
            </li>
          ))}
        </ul>
      )}

      <form className="mesh__send" onSubmit={(event) => void submit(event)}>
        <input
          type="text"
          value={draft}
          maxLength={TEXT_MAX_BYTES}
          placeholder={canSend ? `Message ${channel}` : 'Sending unavailable'}
          disabled={!canSend || busy}
          onChange={(event) => setDraft(event.target.value)}
          aria-label={`Message the ${channel} channel`}
        />
        <button type="submit" className="toggle" disabled={!canSend || busy || draft.trim().length === 0}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </form>
      {error ? <p className="empty text-alert">{error}</p> : null}
      {!canSend && status.connected ? (
        <p className="empty">
          Read-only: set MESH_GATEWAY_NODE and MESH_CHANNEL_INDEX in <code>.env</code> to enable sending.
        </p>
      ) : null}

      {mesh.nodes.length > 0 ? (
        <ul className="rows rows--tight mesh__nodes">
          {mesh.nodes.map((node) => (
            <li key={node.num} className="row">
              <span className="row__label">{nodeLabel(node)}</span>
              <span className="row__value">{nodeMeta(node) || '—'}</span>
              <span className="row__meta">{lastHeard(node)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}
