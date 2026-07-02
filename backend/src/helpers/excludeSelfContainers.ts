import SelfIdentityService from '../services/SelfIdentityService';

export interface DockerContainerListRow {
  Id: string;
  Names?: string[];
  Image?: string;
  ImageID?: string;
  Labels?: Record<string, string>;
}

/** Official Sencho release images (Docker Hub + GHCR). Used when SelfIdentity is unavailable on a peer. */
export function isPublishedSenchoImage(image: string): boolean {
  const lower = image.toLowerCase();
  return /(?:^|\/)saelix\/sencho(?:-dev)?(?:[:@]|$)/.test(lower)
    || /studio-saelix\/sencho(?:-dev)?(?:[:@]|$)/.test(lower);
}

function isLikelySenchoManagementContainer(c: DockerContainerListRow): boolean {
  const name = c.Names?.[0]?.replace(/^\//, '').toLowerCase() ?? '';
  if (name === 'sencho' || name === 'sencho-agent') return true;
  if (c.Image && isPublishedSenchoImage(c.Image)) return true;
  return false;
}

/** Drop the running Sencho instance from container picker lists. */
export async function excludeSelfContainers<T extends DockerContainerListRow>(containers: T[]): Promise<T[]> {
  const self = SelfIdentityService.getInstance();
  await self.initialize();

  return containers.filter(c => {
    const name = c.Names?.[0]?.replace(/^\//, '') ?? '';
    if (self.isOwnContainer(c.Id)) return false;
    if (name && self.isOwnContainer(name)) return false;
    if (c.ImageID && self.isOwnImage(c.ImageID)) return false;
    if (isLikelySenchoManagementContainer(c)) return false;
    return true;
  });
}
