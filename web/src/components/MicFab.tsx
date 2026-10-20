import { useEffect, useRef, useState, type PointerEvent } from 'react';

interface MicFabProps {
  /** The chat is streaming a reply; holds are ignored (send would drop them anyway). */
  disabled: boolean;
  /** The chat overlay is open; the button climbs above its composer row. */
  raised: boolean;
  /** A quick tap: open the typed chat. */
  onTap: () => void;
  /** A finished hold: the final transcript, ready to send as a chat turn. */
  onTranscript: (text: string) => void;
}

/** Shorter is a tap (open the chat), longer arms the recorder. */
const HOLD_MS = 250;
/** MediaRecorder hands over a chunk this often, which paces the live transcript. */
const CHUNK_MS = 1_000;
/** How long a "heard nothing" style notice lingers on the overlay. */
const NOTICE_MS = 2_500;

/** Posts a clip to /api/stt (whisper on ladybird) and returns the transcript. */
async function transcribe(clip: Blob, signal?: AbortSignal): Promise<string> {
  const response = await fetch('/api/stt', {
    method: 'POST',
    headers: { 'Content-Type': clip.type },
    body: clip,
    signal,
  });
  const result = (await response.json().catch(() => null)) as { text?: string; error?: string } | null;
  if (!response.ok) throw new Error(result?.error ?? `the server returned ${response.status}`);
  return result?.text?.trim() ?? '';
}

function MicGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="21" />
    </svg>
  );
}

/**
 * The assistant's front door: a mic pinned to the bottom-right corner, above
 * everything including the chat overlay. Tap opens the typed chat; press and
 * hold records, release sends what was said as a chat turn. While recording, a
 * full-screen overlay pulses and shows the words as whisper hears them.
 *
 * whisper.cpp has no streaming endpoint, so the live transcript is faked: the
 * recorder emits a chunk every second and the whole clip so far is
 * re-transcribed each time, one request in flight at a time. Chrome's webm
 * concatenations decode mid-clip; a container that does not (Safari's mp4
 * tends not to) fails once and turns interim off for the rest of that hold -
 * the animation stays, the transcript arrives on release.
 */
export function MicFab({ disabled, raised, onTap, onTranscript }: MicFabProps) {
  const [phase, setPhase] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [interim, setInterim] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  // getUserMedia only exists in a secure context - https or localhost. Over
  // plain http the hold does nothing and the button is purely the chat opener;
  // docs/stt.md in home-automation covers the HTTPS story.
  const canRecord = typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  // The recorder's callbacks outlive the render that created them.
  const onTapRef = useRef(onTap);
  const onTranscriptRef = useRef(onTranscript);
  onTapRef.current = onTap;
  onTranscriptRef.current = onTranscript;

  const recorderRef = useRef<MediaRecorder | null>(null);
  const pressedRef = useRef(false);
  const heldRef = useRef(false);
  const discardRef = useRef(false);
  const holdTimerRef = useRef<number | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const interimBusyRef = useRef(false);
  const noInterimRef = useRef(false);
  const interimAbortRef = useRef<AbortController | null>(null);

  // Leaving the page mid-recording releases the mic along with everything else.
  useEffect(
    () => () => {
      if (holdTimerRef.current !== null) clearTimeout(holdTimerRef.current);
      if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
      interimAbortRef.current?.abort();
      recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  function flashNotice(message: string) {
    setNotice(message);
    if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  }

  /** Re-transcribes the clip so far; one refusal silences interim for this hold. */
  async function interimPass(chunks: Blob[], type: string) {
    if (interimBusyRef.current || noInterimRef.current) return;
    interimBusyRef.current = true;
    const controller = new AbortController();
    interimAbortRef.current = controller;
    try {
      const text = await transcribe(new Blob(chunks, { type }), controller.signal);
      if (text && recorderRef.current?.state === 'recording') setInterim(text);
    } catch {
      if (!controller.signal.aborted) noInterimRef.current = true;
    } finally {
      interimBusyRef.current = false;
    }
  }

  async function beginRecording() {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      flashNotice('microphone permission was refused');
      return;
    }
    // Released while the permission prompt was up - nothing worth keeping.
    if (!pressedRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    // Chrome/Android record webm/opus; iPhone Safari only mp4. Whisper's
    // bundled ffmpeg converts either, so first supported wins.
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) =>
      MediaRecorder.isTypeSupported(type),
    );
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    const type = () => recorder.mimeType || mimeType || 'audio/webm';
    noInterimRef.current = false;
    discardRef.current = false;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
      // The flush that comes with stop() is the final pass's job, not interim's.
      if (recorder.state === 'recording') void interimPass(chunks, type());
    };
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      recorderRef.current = null;
      interimAbortRef.current?.abort();
      if (discardRef.current) {
        setPhase('idle');
        setInterim('');
        return;
      }
      setPhase('transcribing');
      try {
        const text = await transcribe(new Blob(chunks, { type: type() }));
        if (text) {
          setPhase('idle');
          setInterim('');
          onTranscriptRef.current(text);
          return;
        }
        flashNotice('heard nothing - try again closer to the mic');
      } catch (err) {
        flashNotice(err instanceof Error ? err.message : String(err));
      }
      setPhase('idle');
      setInterim('');
    };

    recorderRef.current = recorder;
    recorder.start(CHUNK_MS);
    setInterim('');
    setPhase('recording');
  }

  function onPointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (pressedRef.current || phase !== 'idle') return;
    // Keep the release on this button even if the finger drifts off it.
    event.currentTarget.setPointerCapture(event.pointerId);
    pressedRef.current = true;
    heldRef.current = false;
    if (canRecord && !disabled) {
      holdTimerRef.current = window.setTimeout(() => {
        heldRef.current = true;
        void beginRecording();
      }, HOLD_MS);
    }
  }

  function endPress(discard: boolean) {
    if (!pressedRef.current) return;
    pressedRef.current = false;
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (recorderRef.current) {
      discardRef.current = discard;
      recorderRef.current.stop();
      return;
    }
    // Never armed the recorder: a short press is the tap path.
    if (!heldRef.current && !discard) onTapRef.current();
  }

  const overlay = phase !== 'idle' || notice;

  return (
    <>
      {overlay ? (
        <div className="voice" role="status" aria-live="polite">
          <div className={`voice__orb${phase === 'recording' ? ' voice__orb--rec' : ''}`} aria-hidden="true">
            <MicGlyph />
          </div>
          <p className="voice__text">
            {notice ?? (interim || (phase === 'transcribing' ? 'Transcribing…' : 'Listening…'))}
          </p>
        </div>
      ) : null}
      <button
        type="button"
        className={`micfab${raised ? ' micfab--raised' : ''}${phase === 'recording' ? ' micfab--rec' : ''}`}
        onPointerDown={onPointerDown}
        onPointerUp={() => endPress(false)}
        onPointerCancel={() => endPress(true)}
        onContextMenu={(event) => event.preventDefault()}
        aria-label={canRecord ? 'Tap for the chat, hold to talk' : 'Open the assistant chat'}
      >
        <MicGlyph />
      </button>
    </>
  );
}
