import fs from 'fs';
import { TLS_CA_FILE_ENV } from './helpers/nativeTls';
import { probeLocalHealth, trustHealthcheckCa } from './helpers/healthcheckProbe';

const caPath = process.env[TLS_CA_FILE_ENV]?.trim();
if (caPath) trustHealthcheckCa(fs.readFileSync(caPath, 'utf8'));

probeLocalHealth()
  .then((status) => {
    process.exit(status === 200 ? 0 : 1);
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
