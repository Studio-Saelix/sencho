/** Mirrors backend/helpers/excludeSelfContainers.ts heuristics for proxied remote lists. */

export interface ContainerPickerRow {
  Id: string;
  Names?: string[];
  Image?: string;
}

function isPublishedSenchoImage(image: string): boolean {
  const lower = image.toLowerCase();
  return /(?:^|\/)saelix\/sencho(?:-dev)?(?:[:@]|$)/.test(lower)
    || /studio-saelix\/sencho(?:-dev)?(?:[:@]|$)/.test(lower);
}

export function isLikelySenchoManagementContainer(c: ContainerPickerRow): boolean {
  const name = c.Names?.[0]?.replace(/^\//, '').toLowerCase() ?? '';
  if (name === 'sencho' || name === 'sencho-agent') return true;
  if (c.Image && isPublishedSenchoImage(c.Image)) return true;
  return false;
}

export function excludeLikelySenchoContainers<T extends ContainerPickerRow>(containers: T[]): T[] {
  return containers.filter(c => !isLikelySenchoManagementContainer(c));
}
