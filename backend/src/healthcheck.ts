import { probeLocalHealth } from './helpers/healthcheckProbe';

probeLocalHealth()
  .then((status) => {
    process.exit(status === 200 ? 0 : 1);
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
