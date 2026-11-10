import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BootstrapApiError,
  FALLBACK_CAPABILITIES,
  checkBootstrapHostKey,
  fetchBootstrapCapabilities,
  retryBootstrapOperation,
  runBootstrapPreflight,
  startBootstrapOperation,
} from './bootstrapApi';
import { invalidationForField, strongestInvalidation } from './invalidation';
import { pathSeparationError, validateBootstrapPath, type BootstrapPathKind } from './pathValidation';
import type {
  BootstrapCapabilities,
  BootstrapForm,
  BootstrapOperation,
  BootstrapOperationDetail,
  BootstrapHostKeyResult,
  BootstrapInvalidation,
  BootstrapPreflightResult,
  BootstrapStep,
} from './types';

/**
 * Step machine for the bootstrap dialog.
 *
 * A configuration revision guards the result: every field edit increments it,
 * and a preflight result is only shown while its own revision matches. That is
 * what keeps a stale plan off the screen when a path changes.
 */

type BusyKind = 'host-key' | 'preflight' | 'approve' | null;

export interface BootstrapFieldError {
  field: 'host' | 'port' | 'username' | 'targetName' | 'privateKey' | 'composeDir' | 'agentDir';
  message: string;
}

export interface UseNodeBootstrapOptions {
  open: boolean;
  /** Injected in tests; defaults to the real API. */
  api?: {
    capabilities: typeof fetchBootstrapCapabilities;
    hostKey: typeof checkBootstrapHostKey;
    preflight: typeof runBootstrapPreflight;
    start?: typeof startBootstrapOperation;
    retry?: typeof retryBootstrapOperation;
  };
}

const EMPTY_FORM: BootstrapForm = {
  targetName: '',
  host: '',
  port: '22',
  username: 'ubuntu',
  privateKey: '',
  passphrase: '',
  composeDir: FALLBACK_CAPABILITIES.defaults.composeDir,
  agentDir: FALLBACK_CAPABILITIES.defaults.agentDir,
};

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function toFieldError(error: unknown): BootstrapFieldError | null {
  if (error instanceof BootstrapApiError && error.field) {
    const allowed: BootstrapFieldError['field'][] = ['host', 'port', 'username', 'targetName', 'privateKey', 'composeDir', 'agentDir'];
    if (allowed.includes(error.field as BootstrapFieldError['field'])) {
      return { field: error.field as BootstrapFieldError['field'], message: error.message };
    }
  }
  return null;
}

function stringDetail(error: BootstrapApiError, key: string): string | null {
  const value = error.details[key];
  return typeof value === 'string' ? value : null;
}

export function useNodeBootstrap({ open, api }: UseNodeBootstrapOptions) {
  const client = useMemo(() => ({
    capabilities: fetchBootstrapCapabilities,
    hostKey: checkBootstrapHostKey,
    preflight: runBootstrapPreflight,
    start: startBootstrapOperation,
    retry: retryBootstrapOperation,
    ...api,
  }), [api]);
  const [form, setForm] = useState<BootstrapForm>(EMPTY_FORM);
  const [capabilities, setCapabilities] = useState<BootstrapCapabilities>(FALLBACK_CAPABILITIES);
  const [step, setStep] = useState<BootstrapStep>('target');
  const [hostKey, setHostKey] = useState<BootstrapHostKeyResult | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [replacing, setReplacing] = useState(false);
  // Set only when a live key change on a host with no pin replaced the key the
  // operator reviewed. Null in every other case, including a live change on a
  // pinned host, which shows the pin instead.
  const [supersededFingerprint, setSupersededFingerprint] = useState<string | null>(null);
  const [result, setResult] = useState<BootstrapPreflightResult | null>(null);
  const [busy, setBusy] = useState<BusyKind>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<BootstrapFieldError[]>([]);
  const [configRevision, setConfigRevision] = useState(0);
  const [resultRevision, setResultRevision] = useState<number | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [invalidations, setInvalidations] = useState<readonly BootstrapInvalidation[]>([]);
  // The stopped operation this wizard is preparing a retry for, if any.
  const [retryOf, setRetryOf] = useState<BootstrapOperation | null>(null);
  const invalidated = strongestInvalidation(invalidations);
  const abortRef = useRef<AbortController | null>(null);
  // The live preflight request, if any. A preflight reply is applied only while
  // its own controller is still here, so any edit that discards the inspection
  // (and any newer request) supersedes it even if the reply is already on the way.
  const preflightRef = useRef<AbortController | null>(null);
  // Bumped whenever the SSH endpoint changes, so a keyscan or preflight response
  // for the previous host, port or user can never populate the current form.
  const targetGenerationRef = useRef(0);
  const dirtyFieldsRef = useRef<Set<keyof BootstrapForm>>(new Set());
  const resultRef = useRef<BootstrapPreflightResult | null>(null);
  const hostKeyRef = useRef<BootstrapHostKeyResult | null>(null);
  const stepRef = useRef<BootstrapStep>('target');

  useEffect(() => {
    resultRef.current = result;
  }, [result]);

  useEffect(() => {
    hostKeyRef.current = hostKey;
  }, [hostKey]);

  useEffect(() => {
    stepRef.current = step;
  }, [step]);

  const resultIsCurrent = result !== null && resultRevision === configRevision;

  // Path syntax and separation are checked as the operator types, so feedback is
  // immediate and never relies on a submit. The server re-validates everything.
  const derivedPathErrors = useMemo<BootstrapFieldError[]>(() => {
    const errors: BootstrapFieldError[] = [];
    const compose = validateBootstrapPath(form.composeDir, 'compose');
    if (compose) errors.push({ field: 'composeDir', message: compose });
    const agent = validateBootstrapPath(form.agentDir, 'agent');
    if (agent) errors.push({ field: 'agentDir', message: agent });
    const separation = pathSeparationError(form.composeDir, form.agentDir);
    if (separation) errors.push(separation);
    return errors;
  }, [form.composeDir, form.agentDir]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    preflightRef.current = null;
    targetGenerationRef.current += 1;
    setForm({ ...EMPTY_FORM, composeDir: capabilities.defaults.composeDir, agentDir: capabilities.defaults.agentDir });
    setStep('target');
    setHostKey(null);
    setTrusted(false);
    setReplacing(false);
    setSupersededFingerprint(null);
    setResult(null);
    setBusy(null);
    setError(null);
    setFieldErrors([]);
    setResultRevision(null);
    setAdvancedOpen(false);
    setInvalidations([]);
    setRetryOf(null);
    dirtyFieldsRef.current.clear();
  }, [capabilities.defaults.agentDir, capabilities.defaults.composeDir]);

  // Fetch the server's defaults once per open. The response is the source of
  // truth for both defaults; the local fallback only covers a failed request.
  useEffect(() => {
    if (!open) {
      // Closing clears the key material and any live request.
      abortRef.current?.abort();
      abortRef.current = null;
      preflightRef.current = null;
      setForm((current) => ({ ...current, privateKey: '', passphrase: '' }));
      setBusy(null);
      setInvalidations([]);
      return;
    }
    const controller = new AbortController();
    void client.capabilities(controller.signal)
      .then((loaded) => {
        setCapabilities(loaded);
        // Only untouched fields take the server defaults: an operator who typed
        // a value while this request was in flight keeps it.
        setForm((current) => ({
          ...current,
          composeDir: dirtyFieldsRef.current.has('composeDir') ? current.composeDir : loaded.defaults.composeDir,
          agentDir: dirtyFieldsRef.current.has('agentDir') ? current.agentDir : loaded.defaults.agentDir,
        }));
      })
      .catch((error: unknown) => {
        // The local defaults are already in state; log so a failing capabilities
        // route is traceable rather than invisible.
        console.warn('Bootstrap capabilities request failed; using local defaults:', error);
      });
    return () => controller.abort();
    // client.* is stable module API unless a test injects it; listing it would
    // re-run the fetch on every render for inline fakes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const clearResult = useCallback((field: keyof BootstrapForm, discardedInFlight: boolean) => {
    // A banner that is already up keeps the strongest reason; one is raised
    // only when a result, or an inspection still on its way, is being discarded.
    const reason = invalidationForField(field);
    const toTarget = reason === 'target';
    const hadResult = resultRef.current !== null || discardedInFlight;
    setInvalidations((current) => (hadResult || current.length > 0 ? [...new Set([...current, reason])] : current));
    setResult(null);
    setResultRevision(null);
    // The pin is a host property, so an edit that is not to the SSH target made
    // from the preflight step can go straight back there with the existing trust. An edit on the
    // target step stays there so the operator can finish typing.
    if (stepRef.current === 'target') {
      setStep('target');
      return;
    }
    setStep(toTarget || !hostKeyRef.current ? 'target' : 'preflight');
  }, []);

  const setField = useCallback((field: keyof BootstrapForm, value: string) => {
    dirtyFieldsRef.current.add(field);
    setForm((current) => ({ ...current, [field]: value }));
    setConfigRevision((revision) => revision + 1);
    setError(null);
    setFieldErrors((current) => current.filter((entry) => entry.field !== field));
    const discardedInFlight = preflightRef.current !== null;
    if (field === 'host' || field === 'port' || field === 'username') {
      targetGenerationRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      preflightRef.current = null;
      setHostKey(null);
      setTrusted(false);
      setReplacing(false);
      setSupersededFingerprint(null);
      // The superseded request no longer owns the busy flag.
      setBusy(null);
      clearResult(field, discardedInFlight);
      return;
    }
    // Every other field feeds the inspection too: a preflight still running
    // describes the previous values, so its reply must not land on this edit.
    const pending = preflightRef.current;
    if (pending) {
      pending.abort();
      preflightRef.current = null;
      if (abortRef.current === pending) {
        abortRef.current = null;
        setBusy(null);
      }
    }
    clearResult(field, discardedInFlight);
  }, [clearResult]);

  const validate = useCallback((): { ok: boolean; errors: BootstrapFieldError[] } => {
    const errors: BootstrapFieldError[] = [];
    if (!form.targetName.trim()) errors.push({ field: 'targetName', message: 'Node name is required.' });
    if (!form.host.trim()) errors.push({ field: 'host', message: 'Host is required.' });
    const port = Number(form.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push({ field: 'port', message: 'Port must be an integer between 1 and 65535.' });
    }
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(form.username.trim())) {
      errors.push({ field: 'username', message: 'SSH user must be a lowercase POSIX user name.' });
    }
    if (!form.privateKey.trim()) errors.push({ field: 'privateKey', message: 'Private key is required.' });
    const composeError = validateBootstrapPath(form.composeDir, 'compose');
    if (composeError) errors.push({ field: 'composeDir', message: composeError });
    const agentError = validateBootstrapPath(form.agentDir, 'agent');
    if (agentError) errors.push({ field: 'agentDir', message: agentError });
    const separation = pathSeparationError(form.composeDir, form.agentDir);
    if (separation) errors.push({ field: separation.field, message: separation.message });
    setFieldErrors(errors);
    return { ok: errors.length === 0, errors };
  }, [form]);

  const checkHostKey = useCallback(async () => {
    const validation = validate();
    if (!validation.ok) return;
    abortRef.current?.abort();
    preflightRef.current = null;
    const controller = new AbortController();
    abortRef.current = controller;
    const generation = targetGenerationRef.current;
    setBusy('host-key');
    setError(null);
    try {
      const response = await client.hostKey(
        { host: form.host.trim(), port: Number(form.port) },
        controller.signal,
      );
      // The form may have moved to another endpoint while this request was in
      // flight; its key and trust state are no longer about the shown target.
      if (targetGenerationRef.current !== generation) return;
      setHostKey(response);
      setTrusted(response.trust === 'trusted');
      setReplacing(false);
      setSupersededFingerprint(null);
      // The target banner asks for exactly this check, so it is done. The
      // key, paths and name banners ask for a preflight and stay up.
      setInvalidations((current) => current.filter((reason) => reason !== 'target'));
      setStep('preflight');
    } catch (caught: unknown) {
      if (isAbort(caught)) return;
      if (targetGenerationRef.current !== generation) return;
      const fieldError = toFieldError(caught);
      if (fieldError) setFieldErrors([fieldError]);
      setError(caught instanceof Error ? caught.message : 'The host key check failed.');
    } finally {
      // Only the current request clears the busy flag: a superseded one
      // finishing late must not re-enable the controls under a newer request.
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(null);
      }
    }
  }, [client, form.host, form.port, validate]);

  const runPreflight = useCallback(async (confirmReplace = false) => {
    if (!hostKey) return;
    const revision = configRevision;
    const generation = targetGenerationRef.current;
    // A replacement names the key and the pin it replaces, or it is not sent.
    const reviewedPin = confirmReplace || replacing ? hostKey.pinnedFingerprint : null;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    preflightRef.current = controller;
    // Only the request that still owns the preflight slot may apply its reply.
    const isCurrent = () => preflightRef.current === controller && targetGenerationRef.current === generation;
    setBusy('preflight');
    setError(null);
    try {
      const response = await client.preflight({
        host: form.host.trim(),
        port: Number(form.port),
        username: form.username.trim(),
        privateKey: form.privateKey,
        passphrase: form.passphrase ? form.passphrase : null,
        expectedFingerprint: hostKey.fingerprint,
        replacePinnedFingerprint: reviewedPin ? hostKey.fingerprint : null,
        reviewedPinnedFingerprint: reviewedPin,
        targetName: form.targetName.trim(),
        composeDir: form.composeDir,
        agentDir: form.agentDir,
        ...(retryOf ? { operationId: retryOf.id } : {}),
      }, controller.signal);
      if (!isCurrent()) return;
      setResult(response);
      setResultRevision(revision);
      setInvalidations([]);
      // The server pinned (or replaced) the reviewed key as part of this run.
      setHostKey((current) => (
        current ? { ...current, trust: 'trusted', pinnedFingerprint: current.fingerprint } : current
      ));
      setReplacing(false);
      setSupersededFingerprint(null);
      setStep(response.plan ? 'plan' : 'preflight');
    } catch (caught: unknown) {
      if (isAbort(caught)) return;
      if (!isCurrent()) return;
      const fieldError = toFieldError(caught);
      if (fieldError) setFieldErrors([fieldError]);
      if (caught instanceof BootstrapApiError
        && (caught.code === 'HOST_KEY_MISMATCH' || caught.code === 'HOST_KEY_UNTRUSTED')) {
        // The pin or the live key changed underneath the keyscan. Keep the
        // identity the server reported and clear the earlier consent. A pinned
        // host shows the pin and needs an explicit replacement confirmation; a
        // host with no pin asks for first trust of the key it presents now; a
        // pin equal to the live key needs nothing further.
        const pinned = stringDetail(caught, 'pinnedFingerprint');
        const observed = stringDetail(caught, 'observedFingerprint');
        const observedAlgorithm = stringDetail(caught, 'observedAlgorithm');
        // The live key can be the very pin the server now holds (another
        // preflight replaced it): nothing is left to replace.
        const liveKey = caught.code === 'HOST_KEY_UNTRUSTED' && observed ? observed : hostKeyRef.current?.fingerprint ?? null;
        const pinIsLive = pinned !== null && pinned === liveKey;
        // A key can only be "changed" against a stored pin. Without one the
        // host is being trusted for the first time, so the dialog asks for
        // that, not for a replacement of a pin that does not exist.
        const nextTrust: BootstrapHostKeyResult['trust'] = pinned === null ? 'unknown' : pinIsLive ? 'trusted' : 'changed';
        const liveKeyChanged = caught.code === 'HOST_KEY_UNTRUSTED' && observed !== null && observed !== hostKey.fingerprint;
        // Drop a previous inspection so the dialog shows the live observation,
        // not the key from the earlier run.
        setResult(null);
        setResultRevision(null);
        setStep('preflight');
        setHostKey((current) => {
          if (!current) return current;
          if (liveKeyChanged && observed) {
            // Everything captured earlier described the previous key.
            return {
              ...current,
              fingerprint: observed,
              algorithm: observedAlgorithm ?? 'unknown',
              knownHostsLine: '',
              trust: nextTrust,
              pinnedFingerprint: pinned,
            };
          }
          return { ...current, trust: nextTrust, pinnedFingerprint: pinned };
        });
        // Keep the key the operator reviewed on screen next to the one the
        // host presents now, so the first-trust prompt can name both.
        setSupersededFingerprint(liveKeyChanged && pinned === null ? hostKey.fingerprint : null);
        setReplacing(false);
        setTrusted(pinIsLive);
      }
      setError(caught instanceof Error ? caught.message : 'The preflight failed.');
    } finally {
      if (preflightRef.current === controller) preflightRef.current = null;
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(null);
      }
    }
  }, [client, configRevision, form, hostKey, replacing, retryOf]);

  /**
   * Prepare a retry of a stopped operation: the server, node name and both
   * directories come from the operation, and the key is entered again because
   * the hub never stored it. The retry then runs the preflight and shows a new
   * plan to approve, like a first run.
   */
  const startRetry = useCallback((operation: BootstrapOperation) => {
    abortRef.current?.abort();
    abortRef.current = null;
    preflightRef.current = null;
    targetGenerationRef.current += 1;
    setForm((current) => ({
      ...current,
      targetName: operation.targetName,
      host: operation.host,
      port: String(operation.port),
      username: operation.username,
      privateKey: '',
      passphrase: '',
      composeDir: operation.composeDir,
      agentDir: operation.agentDir,
    }));
    setAdvancedOpen(operation.agentDir !== capabilities.defaults.agentDir);
    setHostKey(null);
    setTrusted(false);
    setReplacing(false);
    setSupersededFingerprint(null);
    setResult(null);
    setResultRevision(null);
    setInvalidations([]);
    setFieldErrors([]);
    setError(null);
    setBusy(null);
    setConfigRevision((revision) => revision + 1);
    setRetryOf(operation);
    setStep('target');
  }, [capabilities.defaults.agentDir]);

  /** Approve the shown plan: start a run, or retry the operation this wizard prepared. */
  const approve = useCallback(async (): Promise<BootstrapOperationDetail | null> => {
    const plan = resultIsCurrent ? result?.plan : null;
    if (!plan || !hostKey) return null;
    setBusy('approve');
    setError(null);
    const input = {
      host: form.host.trim(),
      port: Number(form.port),
      username: form.username.trim(),
      privateKey: form.privateKey,
      passphrase: form.passphrase ? form.passphrase : null,
      expectedFingerprint: plan.hostKeyFingerprint,
      targetName: form.targetName.trim(),
      composeDir: form.composeDir,
      agentDir: form.agentDir,
      planDigest: plan.digest,
    };
    try {
      const operation = retryOf ? await client.retry(retryOf.id, input) : await client.start(input);
      // The hub holds the key for the run; the form no longer needs it.
      setForm((current) => ({ ...current, privateKey: '', passphrase: '' }));
      setRetryOf(null);
      setStep('run');
      return operation;
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'The plan could not be started.');
      return null;
    } finally {
      setBusy(null);
    }
  }, [client, form, hostKey, result, resultIsCurrent, retryOf]);

  const back = useCallback(() => {
    if (step === 'plan') {
      setStep('preflight');
      return;
    }
    if (step === 'preflight') {
      setStep('target');
      return;
    }
  }, [step]);

  const fieldError = useCallback(
    (field: BootstrapFieldError['field']) => derivedPathErrors.find((entry) => entry.field === field)?.message
      ?? fieldErrors.find((entry) => entry.field === field)?.message
      ?? null,
    [derivedPathErrors, fieldErrors],
  );

  const resetAgentDir = useCallback(() => {
    setField('agentDir', capabilities.defaults.agentDir);
  }, [capabilities.defaults.agentDir, setField]);

  return {
    form,
    setField,
    capabilities,
    step,
    setStep,
    hostKey,
    trusted,
    setTrusted,
    replacing,
    setReplacing,
    supersededFingerprint,
    result,
    resultIsCurrent,
    invalidated,
    busy,
    error,
    setError,
    fieldError,
    fieldErrors,
    validate,
    checkHostKey,
    runPreflight,
    reset,
    back,
    advancedOpen,
    setAdvancedOpen,
    resetAgentDir,
    retryOf,
    startRetry,
    approve,
    pathKindLabel: (kind: BootstrapPathKind) => kind,
  };
}

export type UseNodeBootstrap = ReturnType<typeof useNodeBootstrap>;
