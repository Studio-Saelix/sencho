/**
 * Entry point of the Docker endpoint replacement helper container:
 * `node dist/endpointProviderHelper.js <stage|replace> <operationId>`.
 * It loads only Dockerode and the helper module, never the Sencho app.
 * See helpers/endpointProviderReplace.ts for the sequence.
 */
import fs from 'fs/promises';
import { HELPER_DATA_DIR, errorText, helperFiles, replaceProvider, stageProviderReplacement, type ProviderOutcome, type ProviderReplacePlan } from './helpers/endpointProviderReplace';
import { buildDeps } from './helpers/endpointProviderDeps';

const OPERATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function main(): Promise<number> {
  const [mode, operationId] = process.argv.slice(2);
  if ((mode !== 'stage' && mode !== 'replace') || !operationId || !OPERATION_ID_RE.test(operationId)) {
    process.stdout.write(JSON.stringify({ ok: false, message: 'Usage: endpointProviderHelper <stage|replace> <operationId>' }));
    return 2;
  }
  const plan = JSON.parse(await fs.readFile(helperFiles.plan(HELPER_DATA_DIR, operationId), 'utf8')) as ProviderReplacePlan;
  if (mode === 'stage') {
    const result = await stageProviderReplacement(plan, buildDeps(plan, null));
    process.stdout.write(JSON.stringify(result));
    return result.ok ? 0 : 1;
  }
  const deps = buildDeps(plan, helperFiles.log(HELPER_DATA_DIR, operationId));
  try {
    const outcome = await replaceProvider(plan, deps);
    return outcome.ok ? 0 : 1;
  } catch (error) {
    // `replaceProvider` handles every post-replacement exception itself, so a
    // throw here is before the provider was touched. Record that honestly
    // instead of letting Sencho wait out its deadline for a verdict.
    const outcome: ProviderOutcome = {
      operationId,
      ok: false,
      phase: 'provider',
      error: `The replacement helper could not start the replacement: ${errorText(error)}`,
      rollback: { attempted: false },
    };
    deps.log(`helper failed: ${errorText(error)}`);
    await deps.writeJson(helperFiles.outcome(HELPER_DATA_DIR, operationId), outcome);
    return 1;
  }
}

main().then(code => process.exit(code)).catch(error => {
  process.stdout.write(JSON.stringify({ ok: false, message: errorText(error) }));
  process.exit(1);
});
