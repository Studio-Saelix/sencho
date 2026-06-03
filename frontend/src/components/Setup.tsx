import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ArrowRight, Loader2 } from 'lucide-react';
import { AuthCanvas } from '@/components/auth/AuthCanvas';
import { AuthStepHeader } from '@/components/auth/AuthStepHeader';
import { ErrorRail } from '@/components/auth/ErrorRail';
import { EnvironmentChecks } from '@/components/settings/EnvironmentChecks';

interface SetupProps {
  onComplete: () => void;
}

const INPUT_CLASS =
  'h-11 bg-background/60 border-card-border font-sans text-base shadow-[inset_0_2px_4px_0_oklch(0_0_0/0.25)] placeholder:text-stat-subtitle/60 focus-visible:border-brand/60 focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-0';

type Strength = { label: string; tone: 'weak' | 'fair' | 'strong' } | null;

function gaugePassword(pw: string): Strength {
  if (pw.length === 0) return null;
  if (pw.length < 8) return { label: 'Weak', tone: 'weak' };
  const classes =
    Number(/[a-z]/.test(pw)) +
    Number(/[A-Z]/.test(pw)) +
    Number(/\d/.test(pw)) +
    Number(/[^A-Za-z0-9]/.test(pw));
  if (pw.length >= 12 && classes >= 3) return { label: 'Strong', tone: 'strong' };
  return { label: 'Fair', tone: 'fair' };
}

export function Setup({ onComplete, className, ...props }: SetupProps & React.ComponentPropsWithoutRef<'div'>) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  // The admin account is created in step 1; /api/auth/setup signs the operator
  // in (session cookie), so step 2 can run the admin-gated environment checks
  // before handing off to the console.
  const [step, setStep] = useState<'account' | 'env'>('account');

  const strength = gaugePassword(password);
  const strengthClass =
    strength?.tone === 'strong'
      ? 'text-success'
      : strength?.tone === 'fair'
        ? 'text-warning'
        : strength
          ? 'text-destructive'
          : '';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (username.length < 3) {
      setError('Username must be at least 3 characters');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password, confirmPassword }),
      });
      const data = await response.json();
      if (response.ok && data.success) {
        setStep('env');
      } else {
        setError(data.error || 'Setup failed');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  if (step === 'env') {
    return (
      <div className={cn('relative', className)} {...props}>
        <AuthCanvas
          footer={
            <div className="flex items-center justify-between">
              <span>Console · First boot</span>
              <span className="text-stat-subtitle/70">Account ready</span>
            </div>
          }
        >
          <div className="flex flex-col gap-7">
            <AuthStepHeader
              kicker="SENCHO · ENVIRONMENT"
              hero="Preflight"
              caption="A quick check that this host can run Docker deploys. Warnings won't stop you; each one carries a fix."
            />
            <EnvironmentChecks />
            <Button
              type="button"
              onClick={onComplete}
              className="h-11 w-full bg-brand text-brand-foreground shadow-btn-glow hover:bg-brand/90"
            >
              Enter Sencho<ArrowRight strokeWidth={1.5} />
            </Button>
          </div>
        </AuthCanvas>
      </div>
    );
  }

  return (
    <div className={cn('relative', className)} {...props}>
      <AuthCanvas
        footer={
          <div className="flex items-center justify-between">
            <span>Console · First boot</span>
            <span className="text-stat-subtitle/70">Empty database</span>
          </div>
        }
      >
        <div className="flex flex-col gap-7">
          <AuthStepHeader
            kicker="SENCHO · INITIALIZE"
            hero="Cold start"
            caption="Create the Admiral account to unlock the console."
          />

          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <Field id="username" label="Username">
              <Input
                id="username"
                type="text"
                placeholder="admin"
                required
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className={INPUT_CLASS}
              />
            </Field>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="password"
                  className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle"
                >
                  Password
                </label>
                {strength && (
                  <span className={cn('font-mono text-[10px] uppercase tracking-[0.18em]', strengthClass)}>
                    {strength.label}
                  </span>
                )}
              </div>
              <Input
                id="password"
                type="password"
                required
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={INPUT_CLASS}
              />
            </div>

            <Field id="confirmPassword" label="Confirm password">
              <Input
                id="confirmPassword"
                type="password"
                required
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={INPUT_CLASS}
              />
            </Field>

            {error && <ErrorRail>{error}</ErrorRail>}

            <Button
              type="submit"
              disabled={isLoading}
              className="h-11 w-full bg-brand text-brand-foreground shadow-btn-glow hover:bg-brand/90"
            >
              {isLoading ? (
                <><Loader2 className="animate-spin" strokeWidth={1.5} />Initializing</>
              ) : (
                <>Initialize console<ArrowRight strokeWidth={1.5} /></>
              )}
            </Button>
          </form>
        </div>
      </AuthCanvas>
    </div>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={id}
        className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle"
      >
        {label}
      </label>
      {children}
    </div>
  );
}

