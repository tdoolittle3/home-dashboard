import { useEffect, useRef, useState } from 'react';
import { restartHost } from '../api';

interface RestartFooterProps {
  /** The machine's name, spelled out in the dialog so nobody reboots the wrong thing. */
  hostName: string;
}

type Phase = 'idle' | 'confirm' | 'sending' | 'restarting';

/**
 * The very bottom of the page: one quiet button that reboots the host. A
 * reboot takes every service down for a few minutes, so it always goes through
 * a confirm dialog, and once accepted the page just says so - the dashboard
 * itself is about to go away and its own reconnecting pill takes over.
 */
export function RestartFooter({ hostName }: RestartFooterProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (phase !== 'confirm') return;
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPhase('idle');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase]);

  const confirm = async () => {
    setPhase('sending');
    setError(null);
    try {
      await restartHost();
      setPhase('restarting');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('confirm');
    }
  };

  return (
    <footer className="footer">
      <button
        type="button"
        className="toggle toggle--small footer__restart"
        disabled={phase === 'restarting'}
        onClick={() => setPhase('confirm')}
      >
        {phase === 'restarting' ? `Restarting ${hostName}…` : `Restart ${hostName}`}
      </button>

      {phase === 'confirm' || phase === 'sending' ? (
        <div
          className="confirm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="restart-title"
          onClick={(event) => {
            if (event.target === event.currentTarget && phase === 'confirm') setPhase('idle');
          }}
        >
          <div className="confirm__box">
            <h2 id="restart-title" className="confirm__title">
              Restart {hostName}?
            </h2>
            <p className="confirm__text">
              This reboots the whole machine. Every service on it - cameras, Home Assistant, this dashboard - goes
              offline for a few minutes.
            </p>
            {error ? <p className="confirm__error text-alert">{error}</p> : null}
            <div className="confirm__actions">
              <button
                ref={cancelRef}
                type="button"
                className="toggle"
                disabled={phase === 'sending'}
                onClick={() => setPhase('idle')}
              >
                Cancel
              </button>
              <button
                type="button"
                className="toggle confirm__danger"
                disabled={phase === 'sending'}
                onClick={() => void confirm()}
              >
                {phase === 'sending' ? 'Restarting…' : 'Restart'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </footer>
  );
}
