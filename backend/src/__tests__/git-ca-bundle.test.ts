import { describe, expect, it } from 'vitest';
import { validateCaBundlePem, credentialScopeHost } from '../services/git/caBundle';
import { classifyGitFailure } from '../services/git/errors';

describe('validateCaBundlePem', () => {
    it('accepts a PEM certificate block', () => {
        const pem = '-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAKHHCgVZU1w0MA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNVBAMMCWxv\n-----END CERTIFICATE-----\n';
        expect(validateCaBundlePem(pem)).toBe(pem.trim());
    });

    it('rejects empty and non-PEM input', () => {
        expect(validateCaBundlePem('')).toBeNull();
        expect(validateCaBundlePem('not a cert')).toBeNull();
    });
});

describe('credentialScopeHost', () => {
    it('normalizes host and non-default port', () => {
        expect(credentialScopeHost('Git.Example.COM')).toBe('git.example.com');
        expect(credentialScopeHost('git.example.com', 8443)).toBe('git.example.com:8443');
        expect(credentialScopeHost('git.example.com:8443')).toBe('git.example.com:8443');
    });
});

describe('classifyGitFailure TLS and redirect nuance', () => {
    it('maps hostname mismatch to a clear TLS message', () => {
        const result = classifyGitFailure({
            transportFailure: true,
            reason: 'exit',
            host: 'git.example.com',
            hasToken: false,
            stderr: 'SSL: certificate subject name does not match target host name',
        });
        expect(result.message).toContain('hostname does not match');
    });

    it('maps expired certificates distinctly', () => {
        const result = classifyGitFailure({
            transportFailure: true,
            reason: 'exit',
            host: 'git.example.com',
            hasToken: false,
            stderr: 'certificate has expired',
        });
        expect(result.message).toContain('expired');
    });

    it('maps unknown CA to private-CA guidance', () => {
        const result = classifyGitFailure({
            transportFailure: true,
            reason: 'exit',
            host: 'git.example.com',
            hasToken: false,
            stderr: 'SSL certificate problem: unable to get local issuer certificate',
        });
        expect(result.message).toContain('private CA');
    });

    it('maps redirect-scope and redirect stderr to credential-scope guidance', () => {
        const scoped = classifyGitFailure({
            transportFailure: true,
            reason: 'redirect-scope',
            host: 'git.example.com',
            hasToken: true,
        });
        expect(scoped.message).toContain('redirected');

        const stderr = classifyGitFailure({
            transportFailure: true,
            reason: 'exit',
            host: 'git.example.com',
            hasToken: true,
            stderr: 'The requested URL returned error: 302',
        });
        expect(stderr.message).toContain('redirected');
    });
});
