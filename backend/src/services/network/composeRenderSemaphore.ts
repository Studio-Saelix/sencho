interface SemaphoreState {
  active: number;
  waiters: Array<() => void>;
}

const MAX_ACTIVE_RENDERS = 4;
const states = new Map<number, SemaphoreState>();

async function acquire(nodeId: number): Promise<() => void> {
  const state = states.get(nodeId) ?? { active: 0, waiters: [] };
  states.set(nodeId, state);

  if (state.active >= MAX_ACTIVE_RENDERS) {
    await new Promise<void>(resolve => state.waiters.push(resolve));
  }
  state.active += 1;

  return () => {
    state.active -= 1;
    const next = state.waiters.shift();
    if (next) next();
    if (state.active === 0 && state.waiters.length === 0) states.delete(nodeId);
  };
}

export async function withComposeRenderSlot<T>(nodeId: number, work: () => Promise<T>): Promise<T> {
  const release = await acquire(nodeId);
  try {
    return await work();
  } finally {
    release();
  }
}
