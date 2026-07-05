import { describe, it, expect } from 'vitest';
import {
    extractBuildServicesFromCompose,
    extractBuildServicesFromRenderedConfig,
} from '../services/ImageUpdateService';

describe('extractBuildServicesFromCompose', () => {
    it('returns service names that declare build', () => {
        const yaml = `
services:
  web:
    build: .
  api:
    image: nginx:1.25
  worker:
    build:
      context: ./worker
      dockerfile: Dockerfile
`;
        expect(extractBuildServicesFromCompose(yaml).sort()).toEqual(['web', 'worker']);
    });

    it('returns empty for image-only stacks', () => {
        const yaml = `
services:
  web:
    image: nginx:1.25
`;
        expect(extractBuildServicesFromCompose(yaml)).toEqual([]);
    });

    it('ignores empty build sections', () => {
        const yaml = `
services:
  web:
    build: ""
  api:
    build: {}
`;
        expect(extractBuildServicesFromCompose(yaml)).toEqual([]);
    });
});

describe('extractBuildServicesFromRenderedConfig', () => {
    it('reads build services from a rendered compose json model', () => {
        const rendered = JSON.stringify({
            services: {
                app: { build: { context: '/app' }, image: 'myapp:latest' },
                cache: { image: 'redis:7' },
            },
        });
        expect(extractBuildServicesFromRenderedConfig(rendered)).toEqual(['app']);
    });

    it('includes override-only build services from merged model', () => {
        const rendered = JSON.stringify({
            services: {
                web: { image: 'nginx:1.25' },
                sidecar: { build: './sidecar' },
            },
        });
        expect(extractBuildServicesFromRenderedConfig(rendered)).toEqual(['sidecar']);
    });
});
