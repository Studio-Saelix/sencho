import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatBytes(bytes: number, decimals = 2) {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

export function formatCount(n: number, unit: string): string {
  if (n === 0) return 'None';
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** Format a Unix timestamp (seconds) as a human-readable relative string, e.g. "42s ago", "5m ago". */
export function formatRelativeTime(timestampSeconds: number): string {
  const seconds = Math.floor(Date.now() / 1000 - timestampSeconds);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function visibilityInterval(fn: () => void, ms: number): () => void {
  let interval: ReturnType<typeof setInterval> | null = null;
  const start = () => { if (interval) return; interval = setInterval(fn, ms); };
  const stop = () => { if (interval) { clearInterval(interval); interval = null; } };
  const onVisChange = () => { if (document.hidden) { stop(); } else { fn(); start(); } };
  document.addEventListener('visibilitychange', onVisChange);
  // Do not start a timer when the tab is already hidden (e.g. deep-link opened
  // in a background tab). Resume via visibilitychange when the tab is shown.
  if (!document.hidden) start();
  return () => { stop(); document.removeEventListener('visibilitychange', onVisChange); };
}
