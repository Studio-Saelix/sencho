import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2 } from 'lucide-react';
import {
  BACKUP_CODE_DISPLAY_LENGTH,
  TOTP_LENGTH,
  normalizeBackupCodeInput,
  normalizeTotpInput,
} from '@/lib/mfa';
import { AuthCanvas } from '@/components/auth/AuthCanvas';
import { AuthStepHeader } from '@/components/auth/AuthStepHeader';
import { OtpDigitField } from '@/components/auth/OtpDigitField';
import { ErrorRail } from '@/components/auth/ErrorRail';

type FieldState = 'idle' | 'loading' | 'error' | 'success';

function formatSeconds(total: number): string {
  const mm = Math.floor(total / 60).toString().padStart(2, '0');
  const ss = Math.floor(total % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

export function MfaChallenge({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  const { submitMfa, cancelMfa } = useAuth();
  const [display, setDisplay] = useState('');
  const [raw, setRaw] = useState('');
  const [error, setError] = useState('');
  const [fieldState, setFieldState] = useState<FieldState>('idle');
  const [useBackup, setUseBackup] = useState(false);
  const [retrySeconds, setRetrySeconds] = useState(0);
  const submittedRef = useRef(false);

  useEffect(() => {
    if (retrySeconds <= 0) return;
    const id = window.setInterval(() => {
      setRetrySeconds((s) => (s <= 1 ? 0 : s - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, [retrySeconds]);

  const runSubmit = async (valueToSubmit: string) => {
    setError('');
    setFieldState('loading');
    const result = await submitMfa(valueToSubmit, { isBackupCode: useBackup });
    if (!result.success) {
      if (result.retryAfter && result.retryAfter > 0) {
        setRetrySeconds(Math.ceil(result.retryAfter));
        setError('');
      } else {
        setError(result.error || 'Verification failed');
      }
      setDisplay('');
      setRaw('');
      setFieldState('error');
      submittedRef.current = false;
      window.setTimeout(() => setFieldState('idle'), 600);
      return;
    }
    setFieldState('success');
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (fieldState === 'loading' || !raw) return;
    submittedRef.current = true;
    void runSubmit(raw);
  };

  const handleOtpChange = (value: string) => {
    const normalized = normalizeTotpInput(value);
    setDisplay(normalized);
    setRaw(normalized);
    if (normalized.length < TOTP_LENGTH) {
      submittedRef.current = false;
      if (fieldState === 'error') setFieldState('idle');
    }
    if (
      normalized.length === TOTP_LENGTH &&
      fieldState !== 'loading' &&
      !submittedRef.current
    ) {
      submittedRef.current = true;
      requestAnimationFrame(() => { void runSubmit(normalized); });
    }
  };

  const handleBackupChange = (value: string) => {
    const next = normalizeBackupCodeInput(value);
    setDisplay(next.display);
    setRaw(next.raw);
    if (next.raw.length < 10) submittedRef.current = false;
    if (fieldState === 'error') setFieldState('idle');
  };

  const handleToggleBackup = () => {
    setUseBackup((v) => !v);
    setDisplay('');
    setRaw('');
    setError('');
    setFieldState('idle');
    submittedRef.current = false;
  };

  const throttled = retrySeconds > 0;

  return (
    // data-sn-chrome marks the whole challenge screen, including the throttled
    // state, which renders neither the OTP nor the backup-code input. E2E uses
    // it to tell "the login landed on a second-factor challenge" apart from a
    // bad password without depending on which fields happen to be mounted.
    <div className={cn('relative', className)} data-sn-chrome="mfa-challenge" {...props}>
      <AuthCanvas
        footer={
          <div className="flex items-center justify-between">
            <span>Console · Verify</span>
            <button
              type="button"
              onClick={cancelMfa}
              className="uppercase tracking-[0.18em] text-stat-subtitle/80 transition-colors hover:text-destructive"
            >
              Cancel · Sign out
            </button>
          </div>
        }
      >
        <div className="flex flex-col gap-7">
          <AuthStepHeader
            kicker={throttled ? 'SENCHO · THROTTLED' : 'SENCHO · VERIFY'}
            hero={throttled ? formatSeconds(retrySeconds) : 'Verify'}
            caption={
              throttled
                ? 'Too many attempts. Take a breath and try again shortly.'
                : useBackup
                  ? 'Enter one of your saved backup codes to continue.'
                  : 'Enter the 6-digit code from your authenticator.'
            }
          />

          {throttled ? (
            <ThrottleTile seconds={retrySeconds} />
          ) : useBackup ? (
            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              <div className="flex flex-col gap-1.5">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
                  Backup code · 10 chars
                </span>
                <Input
                  id="mfa-backup"
                  type="text"
                  inputMode="text"
                  autoComplete="one-time-code"
                  autoFocus
                  maxLength={BACKUP_CODE_DISPLAY_LENGTH}
                  value={display}
                  onChange={(e) => handleBackupChange(e.target.value)}
                  placeholder="ABCDE-FGHIJ"
                  className="h-12 bg-background/60 border-card-border text-center font-mono text-lg tabular-nums tracking-[0.3em] shadow-[inset_0_2px_4px_0_oklch(0_0_0/0.25)] focus-visible:border-brand/60 focus-visible:ring-2 focus-visible:ring-brand/40"
                />
              </div>
              {error && <ErrorRail>{error}</ErrorRail>}
              <Button
                type="submit"
                disabled={fieldState === 'loading' || raw.length !== 10}
                className="h-11 w-full bg-brand text-brand-foreground shadow-btn-glow hover:bg-brand/90"
              >
                {fieldState === 'loading' ? (
                  <><Loader2 className="animate-spin" strokeWidth={1.5} />Verifying</>
                ) : (
                  'Verify'
                )}
              </Button>
            </form>
          ) : (
            <div className="flex flex-col gap-5">
              <OtpDigitField
                id="mfa-otp"
                value={display}
                onChange={handleOtpChange}
                state={fieldState}
                disabled={fieldState === 'loading' || fieldState === 'success'}
                autoFocus
              />
              {error && <ErrorRail>{error}</ErrorRail>}
            </div>
          )}

          <ModeToggle
            useBackup={useBackup}
            onToggle={handleToggleBackup}
            disabled={fieldState === 'loading' || throttled}
          />
        </div>
      </AuthCanvas>
    </div>
  );
}

function ThrottleTile({ seconds }: { seconds: number }) {
  return (
    <div className="relative overflow-hidden rounded-md border border-warning/30 bg-warning/6 pl-4 pr-3 py-3">
      <span className="absolute inset-y-0 left-0 w-[3px] bg-warning/70" aria-hidden />
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-warning">Retry in</span>
          <span className="font-mono text-2xl tabular-nums text-stat-value">{formatSeconds(seconds)}</span>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
          Rate limited
        </span>
      </div>
    </div>
  );
}

function ModeToggle({
  useBackup,
  onToggle,
  disabled,
}: {
  useBackup: boolean;
  onToggle: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className="self-start font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle transition-colors hover:text-brand disabled:opacity-50"
    >
      {useBackup ? '[ Use authenticator ]' : '[ Use backup code ]'}
    </button>
  );
}

