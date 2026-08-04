/**
 * Shared managed-scope image attribution for prune plan, estimate, and
 * pruneManagedOnly. Container-derived repository keys only (no compose spawn).
 *
 * Repo-key parsing mirrors parseImageRef (registry-api) without importing that
 * module, so DockerController prune paths stay free of its HTTP/Cache deps.
 */

export type ManagedImageReason = 'label' | 'becomes-free' | 'container-id' | 'repo-match';

export type ManagedImageClassification =
  | { eligible: true; reason: ManagedImageReason; stackName?: string }
  | { eligible: false };

export interface ManagedContainerForAttribution {
  Image?: string;
  ImageID?: string;
  stack: string;
}

export interface ListedImageForAttribution {
  Id: string;
  RepoTags?: string[] | null;
}

/**
 * Repository key for prune attribution: registry/repo without tag.
 * Digests and empty refs return null.
 * Aligns with parseImageRef host/library normalization so nginx:1 and
 * docker.io/library/nginx compare equal.
 */
export function imageRepositoryKey(ref: string): string | null {
  let s = ref.trim();
  if (!s || s === '<none>:<none>' || s.startsWith('sha256:')) return null;

  const atIdx = s.indexOf('@');
  if (atIdx !== -1) s = s.slice(0, atIdx);

  let registry = 'registry-1.docker.io';
  let rest = s;

  const slashIdx = s.indexOf('/');
  if (slashIdx !== -1) {
    const firstPart = s.slice(0, slashIdx);
    if (firstPart.includes('.') || firstPart.includes(':') || firstPart === 'localhost') {
      registry = (firstPart === 'docker.io' || firstPart === 'index.docker.io')
        ? 'registry-1.docker.io'
        : firstPart;
      rest = s.slice(slashIdx + 1);
    }
  }

  const colonIdx = rest.lastIndexOf(':');
  if (colonIdx > 0) {
    rest = rest.slice(0, colonIdx);
  }

  if (!rest) return null;
  if (registry === 'registry-1.docker.io' && !rest.includes('/')) {
    rest = `library/${rest}`;
  }
  return `${registry}/${rest}`;
}

function usableTags(repoTags: string[] | null | undefined): string[] {
  if (!repoTags) return [];
  return repoTags.filter((tag) => Boolean(tag) && tag !== '<none>:<none>');
}

/**
 * Repo keys currently used by managed containers, for matching free previous tags.
 * Sources: (a) container.Image string; (b) RepoTags of listed image Id === ImageID.
 */
export function buildManagedImageRepoSet(
  managedContainers: ManagedContainerForAttribution[],
  images: ListedImageForAttribution[],
): { repoKeys: Set<string>; repoToStack: Map<string, string> } {
  const byId = new Map(images.map((img) => [img.Id, img]));
  const repoKeys = new Set<string>();
  const repoToStack = new Map<string, string>();
  const multiOwner = new Set<string>();

  const addKey = (key: string | null, stack: string) => {
    if (!key) return;
    repoKeys.add(key);
    if (multiOwner.has(key)) return;
    const existing = repoToStack.get(key);
    if (!existing) repoToStack.set(key, stack);
    else if (existing !== stack) {
      repoToStack.delete(key);
      multiOwner.add(key);
    }
  };

  for (const c of managedContainers) {
    addKey(imageRepositoryKey(c.Image ?? ''), c.stack);
    if (!c.ImageID) continue;
    const listed = byId.get(c.ImageID);
    for (const tag of usableTags(listed?.RepoTags)) {
      addKey(imageRepositoryKey(tag), c.stack);
    }
  }

  return { repoKeys, repoToStack };
}

function imageRepoKeys(repoTags: string[] | null | undefined): string[] {
  return usableTags(repoTags)
    .map((tag) => imageRepositoryKey(tag))
    .filter((key): key is string => key != null);
}

/**
 * Classify a free or becomes-free image under managed scope.
 * Caller must already filter self, held, and non-free (except becomesFree path).
 *
 * resolveStack is resolveContainerStack-equivalent for the image's labels.
 */
export function classifyManagedImageCandidate(input: {
  imageId: string;
  labels: Record<string, string> | undefined;
  repoTags: string[] | null | undefined;
  becomesFree: boolean;
  managedImageIds: Set<string>;
  unmanagedImageIds: Set<string>;
  repoKeys: Set<string>;
  repoToStack: Map<string, string>;
  resolveStack: (labels: Record<string, string> | undefined) => string | null;
}): ManagedImageClassification {
  const {
    imageId,
    labels,
    repoTags,
    becomesFree,
    managedImageIds,
    unmanagedImageIds,
    repoKeys,
    repoToStack,
    resolveStack,
  } = input;

  if (unmanagedImageIds.has(imageId)) return { eligible: false };

  const projectPresent = Boolean(labels?.['com.docker.compose.project']);
  const stackFromLabels = resolveStack(labels);

  // R1: present project label that does not resolve to a known stack: never managed.
  if (projectPresent && !stackFromLabels) return { eligible: false };

  if (stackFromLabels) {
    return { eligible: true, reason: 'label', stackName: stackFromLabels };
  }

  if (becomesFree) {
    return { eligible: true, reason: 'becomes-free' };
  }

  if (managedImageIds.has(imageId)) {
    return { eligible: true, reason: 'container-id' };
  }

  for (const key of imageRepoKeys(repoTags)) {
    if (repoKeys.has(key)) {
      return {
        eligible: true,
        reason: 'repo-match',
        stackName: repoToStack.get(key),
      };
    }
  }

  return { eligible: false };
}

export function managedImagePlanReason(reason: ManagedImageReason): string {
  if (reason === 'becomes-free') {
    return 'Image becomes unused after planned container removal';
  }
  if (reason === 'repo-match') {
    return 'Unused image whose repository is used by a Sencho stack';
  }
  return 'Image is not used by any container';
}
