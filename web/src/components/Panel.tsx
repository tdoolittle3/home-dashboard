import type { ReactNode } from 'react';

interface PanelProps {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Panel({ title, aside, children, className }: PanelProps) {
  return (
    <section className={className ? `panel ${className}` : 'panel'}>
      <header className="panel__header">
        <h2>{title}</h2>
        {aside ? <span className="panel__aside">{aside}</span> : null}
      </header>
      <div className="panel__body">{children}</div>
    </section>
  );
}
