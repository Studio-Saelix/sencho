import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BootstrapApiError,
  FALLBACK_CAPABILITIES,
  checkBootstrapHostKey,
  fetchBootstrapCapabilities,
  runBootstrapPreflight,
} from './bootstrapApi';
import { pathSeparationError, validateBootstrapPath, type BootstrapPathKind } from './pathValidation';
import type {
  BootstrapCapabilities,
  BootstrapForm,
  BootstrapHostKeyResult,
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

type BusyKind = 'host-key' | 'preflight' | null;

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

export function useNodeBootstrap({ open, api }: UseNodeBootstrapOptions) {
  const client = api ?? {
    capabilities: fetchBootstrapCapabilities,
    hostKey: checkBootstrapHostKey,
    preflight: runBootstrapPreflight,
  };
  const [form, setForm] = useState<BootstrapForm>(EMPTY_FORM);
  const [capabilities, setCapabilities] = useState<BootstrapCapabilities>(FALLBACK_CAPABILITIES);
  const [step, setStep] = useState<BootstrapStep>('target');
  const [hostKey, setHostKey] = useState<BootstrapHostKeyResult | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [result, setResult] = useState<BootstrapPreflightResult | null>(null);
  const [busy, setBusy] = useState<BusyKind>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<BootstrapFieldError[]>([]);
  const [configRevision, setConfigRevision] = useState(0);
  const [resultRevision, setResultRevision] = useState<number | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [invalidated, setInvalidated] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Bumped whenever the SSH endpoint changes, so a keyscan response for the
  // previous host, port or user can never populate the current form.
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
    targetGenerationRef.current += 1;
    setForm({ ...EMPTY_FORM, composeDir: capabilities.defaults.composeDir, agentDir: capabilities.defaults.agentDir });
    setStep('target');
    setHostKey(null);
    setTrusted(false);
    setReplacing(false);
    setResult(null);
    setBusy(null);
    setError(null);
    setFieldErrors([]);
    setResultRevision(null);
    setAdvancedOpen(false);
    setInvalidated(false);
    dirtyFieldsRef.current.clear();
  }, [capabilities.defaults.agentDir, capabilities.defaults.composeDir]);

  // Fetch the server's defaults once per open. The response is the source of
  // truth for both defaults; the local fallback only covers a failed request.
  useEffect(() => {
    if (!open) {
      // Closing clears the key material and any live request.
      abortRef.current?.abort();
      abortRef.current = null;
      setForm((current) => ({ ...current, privateKey: '', passphrase: '' }));
      setBusy(null);
      setInvalidated(false);
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

  const clearResult = useCallback((toTarget = false) => {
    if (resultRef.current) setInvalidated(true);
    setResult(null);
    setResultRevision(null);
    // The pin is a host property, so a path or key edit made from the preflight
    // step can go straight back there with the existing trust. An edit on the
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
    if (field === 'host' || field === 'port' || field === 'username') {
      targetGenerationRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      setHostKey(null);
      setTrusted(false);
      setReplacing(false);
      clearResult(true);
      return;
    }
    clearResult();
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
      setStep('preflight');
    } catch (caught: unknown) {
      if (isAbort(caught)) return;
      if (targetGenerationRef.current !== generation) return;
      const fieldError = toFieldError(caught);
      if (fieldError) setFieldErrors([fieldError]);
      setError(caught instanceof Error ? caught.message : 'The host key check failed.');
    } finally {
      setBusy(null);
    }
  }, [client, form.host, form.port, validate]);

  const runPreflight = useCallback(async (confirmReplace = false) => {
    if (!hostKey) return;
    const revision = configRevision;
    const generation = targetGenerationRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
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
        replacePinnedFingerprint: confirmReplace || replacing ? hostKey.fingerprint : null,
        targetName: form.targetName.trim(),
        composeDir: form.composeDir,
        agentDir: form.agentDir,
      }, controller.signal);
      if (targetGenerationRef.current !== generation) return;
      setResult(response);
      setResultRevision(revision);
      setInvalidated(false);
      setStep(response.plan ? 'plan' : 'preflight');
    } catch (caught: unknown) {
      if (isAbort(caught)) return;
      if (targetGenerationRef.current !== generation) return;
      const fieldError = toFieldError(caught);
      if (fieldError) setFieldErrors([fieldError]);
      if (caught instanceof BootstrapApiError
        && (caught.code === 'HOST_KEY_MISMATCH' || caught.code === 'HOST_KEY_UNTRUSTED')) {
        // The pin or the live key changed underneath the keyscan. Keep the
        // identity the server reported, show the pin, and require an explicit
        // replacement confirmation before another run.
        const pinned = typeof caught.details.pinnedFingerprint === 'string'
          ? caught.details.pinnedFingerprint
          : null;
        const observed = typeof caught.details.observedFingerprint === 'string'
          ? caught.details.observedFingerprint
          : null;
        // Drop a previous inspection so the dialog shows the live observation,
        // not the key from the earlier run.
        setResult(null);
        setResultRevision(null);
        setStep('preflight');
        setHostKey((current) => {
          if (!current) return current;
          if (caught.code === 'HOST_KEY_UNTRUSTED' && observed) {
            return { ...current, fingerprint: observed, trust: 'changed', pinnedFingerprint: pinned };
          }
          return { ...current, trust: 'changed', pinnedFingerprint: pinned };
        });
        setReplacing(false);
        setTrusted(false);
      }
      setError(caught instanceof Error ? caught.message : 'The preflight failed.');
    } finally {
      setBusy(null);
    }
  }, [client, configRevision, form, hostKey, replacing]);

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
    pathKindLabel: (kind: BootstrapPathKind) => kind,
  };
}

export type UseNodeBootstrap = ReturnType<typeof useNodeBootstrap>;
