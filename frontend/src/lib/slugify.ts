/** Slugify a name into a safe, lowercase URL/filename segment. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '') || 'unnamed';
}
