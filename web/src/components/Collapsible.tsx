import { useState, type ReactNode } from 'react';

interface CollapsibleProps {
  /** What opening reveals, phrased as a noun: rendered as "Show <label>" / "Hide <label>". */
  label: string;
  children: ReactNode;
}

/**
 * A show-more fold for the long tail of a panel: headline content stays put,
 * the detail list accordions open on demand. Closed by default every load -
 * the dashboard is a glance first, a drill-down second.
 */
export function Collapsible({ label, children }: CollapsibleProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className={open ? 'collapsible collapsible--open' : 'collapsible'}>
      <button type="button" className="collapsible__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="collapsible__chevron" aria-hidden="true" />
        {open ? `Hide ${label}` : `Show ${label}`}
      </button>
      <div className="collapsible__body">
        <div className="collapsible__inner">{children}</div>
      </div>
    </div>
  );
}
