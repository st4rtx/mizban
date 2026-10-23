import { useEffect, type ReactNode } from 'react';

const P = {
  floor: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  kitchen: 'M12 3c1 3 4 4.5 4 8.5A4 4 0 0 1 12 15.5 4 4 0 0 1 8 11.5c0-1.6.7-2.6 1.5-3.6.6 1 1.2 1.3 1.8 1.3C11.8 7 11.2 5 12 3zM6 19h12v2H6z',
  chart: 'M4 20V10m6 10V4m6 16v-7m4 7H2',
  menu: 'M4 6h16M4 12h16M4 18h10',
  logout: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 8l-4 4 4 4M6 12h10',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6L6 18',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  cash: 'M3 7h18v10H3zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 10v.01M18 14v.01',
  card: 'M3 6h18v12H3zM3 10h18M7 15h4',
  transfer: 'M7 7h13l-3-3M17 17H4l3 3',
  chevron: 'M14 6l-6 6 6 6',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 3.5-6 8-6s8 2 8 6',
  bag: 'M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2',
  tag: 'M3 12V4h8l10 10-8 8zM7.5 8v.01',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  refresh: 'M20 11a8 8 0 0 0-14-4M4 4v4h4M4 13a8 8 0 0 0 14 4M20 20v-4h-4',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 20c0-3.5 3-5 7-5s7 1.5 7 5M17 4.5a3.5 3.5 0 0 1 0 6.5M18 15c2.5.4 4 1.7 4 5',
  print: 'M7 9V3h10v6M7 17H4v-6h16v6h-3M7 14h10v7H7z',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4v6M9 14v6',
} as const;
export type IconName = keyof typeof P;

export function Icon({ name, size }: { name: IconName; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name]} />
    </svg>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="x" onClick={onClose} aria-label="بستن"><Icon name="x" /></button>
        </header>
        <div className="body">{children}</div>
      </div>
    </div>
  );
}

export function Logo({ size = 44 }: { size?: number }) {
  return (
    <svg className="mark" viewBox="0 0 48 48" width={size} height={size} aria-label="میزبان">
      <rect width="48" height="48" rx="13" fill="#0e9594" />
      <path d="M24 7l4.2 8 8.8-2.2-2.2 8.8L43 26l-8.2 4.2 2.2 8.8-8.8-2.2L24 45l-4.2-8-8.8 2.2 2.2-8.8L5 26l8.2-4.2L11 13l8.8 2.2z" fill="#fff" opacity="0.96" />
      <circle cx="24" cy="26" r="6" fill="#0f2a33" />
    </svg>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return <div className="empty"><b>{title}</b>{hint}</div>;
}

export const Skeleton = ({ h = 20, w = '100%' }: { h?: number; w?: string | number }) => <div className="skeleton" style={{ height: h, width: w }} />;
