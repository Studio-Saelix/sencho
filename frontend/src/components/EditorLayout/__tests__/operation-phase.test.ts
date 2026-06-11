import { describe, it, expect } from 'vitest';
import { classifyOperationPhase } from '../operation-phase';
import type { ParsedLogRow, LogStage } from '@/components/log-rendering/composeLogParser';

const row = (message: string, stage: LogStage = 'LOG'): ParsedLogRow => ({
    id: message, timestamp: '', stage, level: 'info', message, raw: message,
});

describe('classifyOperationPhase', () => {
    it('returns null with no rows or no phase markers', () => {
        expect(classifyOperationPhase([], 'update')).toBeNull();
        expect(classifyOperationPhase([row('Attaching to web-1')], 'update')).toBeNull();
    });

    it('classifies the update phase banners', () => {
        expect(classifyOperationPhase([row('=== Pulling latest images ===')], 'update')).toBe('Pulling images');
        expect(classifyOperationPhase([row('=== Recreating containers ===')], 'update')).toBe('Recreating containers');
        expect(classifyOperationPhase([row('=== Pruned dangling images (120MB) ===')], 'update')).toBe('Pruning images');
        expect(classifyOperationPhase([row('=== Backup created for atomic update ===')], 'update')).toBe('Preparing');
    });

    it('classifies docker compose stages', () => {
        expect(classifyOperationPhase([row('[+] Pulling 2/3', 'PULL')], 'deploy')).toBe('Pulling images');
        expect(classifyOperationPhase([row('[+] Starting 1/1', 'START')], 'deploy')).toBe('Starting containers');
    });

    it('treats compose v2 per-layer pull progress as pulling', () => {
        expect(classifyOperationPhase([row('doplarr Pulling')], 'deploy')).toBe('Pulling images');
        expect(classifyOperationPhase([row('45e54b3153b9 Downloading 4.194MB')], 'deploy')).toBe('Pulling images');
        expect(classifyOperationPhase([row('45e54b3153b9 Extracting')], 'update')).toBe('Pulling images');
    });

    it('uses action-aware wording for the create stage', () => {
        expect(classifyOperationPhase([row('[+] Creating 1/1', 'CREATE')], 'update')).toBe('Recreating containers');
        expect(classifyOperationPhase([row('[+] Creating 1/1', 'CREATE')], 'deploy')).toBe('Creating containers');
        expect(classifyOperationPhase([row('[+] Creating 1/1', 'CREATE')], 'install')).toBe('Creating containers');
    });

    it('returns the latest phase (newest-first wins)', () => {
        const rows = [row('[+] Pulling', 'PULL'), row('[+] Creating', 'CREATE'), row('[+] Starting', 'START')];
        expect(classifyOperationPhase(rows, 'deploy')).toBe('Starting containers');
    });
});
