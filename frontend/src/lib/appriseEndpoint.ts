/** Pathname-based Apprise endpoint mode; mirrors backend classifyAppriseEndpoint. */
export const APPRISE_NOTIFY_KEY = /^[A-Za-z0-9_-]{1,128}$/;

function notifyKeyFromPath(path: string): string | null {
  const match = path.match(/^\/notify\/([^/]+)$/);
  return match ? match[1] : null;
}

export function classifyAppriseEndpoint(url: string): 'keyed' | 'stateless' | null {
  try {
    const path = new URL(url).pathname.replace(/\/$/, '');
    const key = notifyKeyFromPath(path);
    if (key !== null) return APPRISE_NOTIFY_KEY.test(key) ? 'keyed' : null;
    if (path === '/notify') return 'stateless';
    return null;
  } catch {
    return null;
  }
}

export function isStatelessAppriseEndpoint(url: string): boolean {
  return classifyAppriseEndpoint(url) === 'stateless';
}

export function isKeyedAppriseEndpoint(url: string): boolean {
  return classifyAppriseEndpoint(url) === 'keyed';
}
