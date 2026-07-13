import { describe, expect, it } from 'vitest';
import { classifyImageChannel, normalizeImageRepository } from '../helpers/imageChannel';

describe('image channel classification', () => {
    it.each([
        'saelix/sencho:latest',
        'docker.io/saelix/sencho:latest',
        'index.docker.io/saelix/sencho@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'ghcr.io/studio-saelix/sencho:v1.2.3',
        'ghcr.io/studio-saelix/sencho-dev:dev',
    ])('classifies the canonical Community alias %s', (imageRef) => {
        expect(classifyImageChannel(imageRef)).toBe('community');
    });

    it('classifies the exact Hardened repository', () => {
        expect(classifyImageChannel('ghcr.io/studio-saelix/sencho-hardened:v1.2.3')).toBe('hardened');
    });

    it('keeps custom and similarly named repositories unknown', () => {
        expect(classifyImageChannel('registry.example.com:5000/sencho:1.0.0')).toBe('unknown');
        expect(classifyImageChannel('ghcr.io/studio-saelix/sencho-hardened-mirror:1.0.0')).toBe('unknown');
    });

    it('normalizes Docker Hub aliases without changing registries that use ports', () => {
        expect(normalizeImageRepository('docker.io/saelix/sencho:latest')).toBe('saelix/sencho');
        expect(normalizeImageRepository('index.docker.io/saelix/sencho:latest')).toBe('saelix/sencho');
        expect(normalizeImageRepository('registry.example.com:5000/saelix/sencho:latest'))
            .toBe('registry.example.com:5000/saelix/sencho');
    });
});
