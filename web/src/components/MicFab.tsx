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
const CHUNK_MS = 500;
/** How long a "heard nothing" style notice lingers on the overlay. */
const NOTICE_MS = 2_500;

/**
 * whisper labels non-speech instead of staying quiet - [BLANK_AUDIO],
 * ( crickets ), *click*, ♪ - so a silent clip comes back as a bracketed
 * annotation, not an empty string. Strip the labels so silence reads as
 * silence: the overlay keeps saying "Listening…" and a silent release is
 * "heard nothing" rather than [BLANK_AUDIO] sent to the model.
 */
function cleanTranscript(raw: string): string {
  const text = raw
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Decoder stutter on near-silence can also spill bare punctuation ("( ( (");
  // words have letters, so anything without any is noise.
  return /[\p{L}\p{N}]/u.test(text) ? text : '';
}

/**
 * Posts a clip to /api/stt (whisper on ladybird) and returns the cleaned
 * transcript. `seconds` marks an interim pass on a still-growing clip: the
 * server fits whisper's encoder window to that length, which turns a ~2.4s
 * fixed-cost pass into well under a second. The final pass omits it.
 */
async function transcribe(clip: Blob, opts: { seconds?: number; signal?: AbortSignal } = {}): Promise<string> {
  const query = opts.seconds ? `?seconds=${opts.seconds}` : '';
  const response = await fetch(`/api/stt${query}`, {
    method: 'POST',
    headers: { 'Content-Type': clip.type },
    body: clip,
    signal: opts.signal,
  });
  const result = (await response.json().catch(() => null)) as { text?: string; error?: string } | null;
  if (!response.ok) throw new Error(result?.error ?? `the server returned ${response.status}`);
  return cleanTranscript(result?.text ?? '');
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
  const voicedRef = useRef(false);
  const meterRef = useRef<{ timer: number; ctx: AudioContext } | null>(null);

  // Leaving the page mid-recording releases the mic along with everything else.
  useEffect(
    () => () => {
      if (holdTimerRef.current !== null) clearTimeout(holdTimerRef.current);
      if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
      interimAbortRef.current?.abort();
      stopMeter();
      recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  function stopMeter() {
    if (!meterRef.current) return;
    clearInterval(meterRef.current.timer);
    void meterRef.current.ctx.close();
    meterRef.current = null;
  }

  /**
   * whisper hallucinates words out of dead air ("you", "thank you") rather
   * than admitting silence, so an analyser watches the raw stream and nothing
   * is transcribed until something audible actually happened. The threshold
   * sits well under speech but above room tone; no analyser, no gate.
   */
  function startMeter(stream: MediaStream) {
    voicedRef.current = false;
    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      ctx.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const timer = window.setInterval(() => {
        if (voicedRef.current) return;
        analyser.getFloatTimeDomainData(samples);
        if (samples.some((sample) => Math.abs(sample) > 0.02)) voicedRef.current = true;
      }, 100);
      meterRef.current = { timer, ctx };
    } catch {
      voicedRef.current = true;
    }
  }

  function flashNotice(message: string) {
    setNotice(message);
    if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  }

  /**
   * Re-transcribes the clip so far, back to back for as long as new audio
   * keeps arriving - the pass itself is the pacing, not the chunk timer. One
   * refusal (a container whisper cannot decode mid-clip) silences interim for
   * the rest of this hold; the stop abort just ends the loop.
   */
  async function interimLoop(chunks: Blob[], type: string) {
    if (interimBusyRef.current || noInterimRef.current) return;
    interimBusyRef.current = true;
    try {
      let taken = 0;
      while (recorderRef.current?.state === 'recording' && chunks.length > taken) {
        taken = chunks.length;
        // Nothing audible yet - keep listening, save whisper the no-ops.
        if (!voicedRef.current) continue;
        const controller = new AbortController();
        interimAbortRef.current = controller;
        const text = await transcribe(new Blob(chunks.slice(0, taken), { type }), {
          seconds: (taken * CHUNK_MS) / 1000,
          signal: controller.signal,
        });
        if (text && recorderRef.current?.state === 'recording') setInterim(text);
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) noInterimRef.current = true;
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
      if (recorder.state === 'recording') void interimLoop(chunks, type());
    };
    recorder.onstop = async () => {
      stopMeter();
      stream.getTracks().forEach((track) => track.stop());
      recorderRef.current = null;
      interimAbortRef.current?.abort();
      if (discardRef.current) {
        setPhase('idle');
        setInterim('');
        return;
      }
      if (!voicedRef.current) {
        flashNotice('heard nothing - try again closer to the mic');
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
    startMeter(stream);
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
