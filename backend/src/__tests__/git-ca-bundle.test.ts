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

    it('maps curl\'s IP-address SAN mismatch wording to the same clear TLS message', () => {
        const result = classifyGitFailure({
            transportFailure: true,
            reason: 'exit',
            host: 'git.example.com',
            hasToken: false,
            stderr: "SSL: no alternative certificate subject name matches target ipv4 address '172.18.0.1'",
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

    it('maps a TLS backend that reports an untrusted signer to private-CA guidance', () => {
        const result = classifyGitFailure({
            transportFailure: true,
            reason: 'exit',
            host: '127.0.0.1',
            hasToken: false,
            stderr: "fatal: unable to access 'https://127.0.0.1:44557/app.git/': SSL certificate verification failed: certificate signer not trusted. (CAfile: /tmp/git/combined-ca.pem CRLfile: none)",
        });
        expect(result.code).toBe('GIT_ERROR');
        expect(result.message).toContain('TLS certificate error reaching');
        expect(result.message).toContain('private CA');
    });

    it('keeps the specific message when the same backend reports an expired certificate', () => {
        const result = classifyGitFailure({
            transportFailure: true,
            reason: 'exit',
            host: 'git.example.com',
            hasToken: false,
            stderr: 'SSL certificate verification failed: certificate has expired',
        });
        expect(result.message).toContain('expired');
        expect(result.message).not.toContain('private CA');
    });

    it('leaves a certificate failure that is not about trust to the generic message', () => {
        const result = classifyGitFailure({
            transportFailure: true,
            reason: 'exit',
            host: 'git.example.com',
            hasToken: false,
            stderr: 'fatal: unable to access \'https://git.example.com/app.git/\': SSL certificate verification failed: certificate uses insecure algorithm. (CAfile: /etc/ssl/certs/ca-certificates.crt CRLfile: none)',
        });
        expect(result.message).not.toContain('private CA');
        expect(result.message).toContain('insecure algorithm');
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
