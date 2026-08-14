/**
 * Pure candidate compose invocation builder.
 *
 * Derives the ordered docker-compose argv (`-f`, `-p`, optional
 * `--project-directory`, `--env-file`) from the *candidate* Git selection,
 * never from the currently applied deploy spec. Using the live spec here would
 * stamp the previous generation's file list onto a new one.
 *
 * Project-env-file flags are current stack configuration (not prior spec), so
 * the caller may pass them to keep deploy-time env files on the new generation.
 */
import path from 'path';
import { gitSourceLocalComposeFiles } from './gitComposeFiles';
import { isPathWithinBase, isValidRelativeStackPath } from './validation';

export interface CandidateComposeInvocationInput {
    stackName: string;
    composePaths: string[];
    contextDir: string | null;
    /** Stack directory (absolute). Used only to resolve `--project-directory` and `--env-file`. */
    stackDir: string;
    syncEnv: boolean;
    envContentPresent: boolean;
    /** Stack-root project env files currently configured for this stack. */
    projectEnvFiles?: string[];
    /**
     * True when an unmanaged stack-root `.env` will survive promotion.
     * Ignored when `syncEnv` is true; that path uses `envContentPresent` only.
     */
    rootEnvFilePresent?: boolean;
}

export function buildCandidateComposeInvocation(input: CandidateComposeInvocationInput): string[] {
    const { stackName, composePaths, contextDir, stackDir, syncEnv, envContentPresent } = input;
    const stackRoot = path.resolve(stackDir);
    const args: string[] = [];
    const rootEnvFilePresent = input.rootEnvFilePresent === true;

    const emitFileArgs = composePaths.length > 1 || !!contextDir;
    if (emitFileArgs) {
        const localFiles = gitSourceLocalComposeFiles(composePaths);
        for (const file of localFiles) {
            if (!file || !isValidRelativeStackPath(file)) {
                throw new Error(`Invalid compose file path in candidate selection for stack "${stackName}"`);
            }
            if (!isPathWithinBase(path.resolve(stackRoot, file), stackRoot)) {
                throw new Error(`Compose file path escapes the stack directory for stack "${stackName}"`);
            }
            args.push('-f', file);
        }
        args.push('-p', stackName);
        if (contextDir) {
            if (!isValidRelativeStackPath(contextDir)) {
                throw new Error(`Invalid context directory in candidate selection for stack "${stackName}"`);
            }
            const ctxAbs = path.resolve(stackRoot, contextDir);
            if (!isPathWithinBase(ctxAbs, stackRoot)) {
                throw new Error(`Context directory escapes the stack directory for stack "${stackName}"`);
            }
            args.push('--project-directory', ctxAbs);
        }
    }

    const projectEnvFiles = input.projectEnvFiles ?? [];
    if (projectEnvFiles.length > 0) {
        for (const file of projectEnvFiles) {
            if (!file || !isValidRelativeStackPath(file)) {
                throw new Error(`Invalid project env file path for stack "${stackName}": "${file}"`);
            }
            if (file.includes('/') || file.includes('\\')) {
                throw new Error(
                    `Project env file "${file}" for stack "${stackName}" must be at the stack root.`,
                );
            }
            const envPath = path.resolve(stackRoot, file);
            if (!isPathWithinBase(envPath, stackRoot)) {
                throw new Error(`Project env file path escapes stack directory for stack "${stackName}": "${file}"`);
            }
            args.push('--env-file', envPath);
        }
        return args;
    }

    // Compose auto-loads stack-root .env for single-file selections. For a
    // context dir, emit --env-file only when this generation will own `.env`
    // (sync-env content) or an unmanaged live file will survive promotion.
    // A managed `.env` scheduled for deletion must not appear here.
    const includeRootEnvFile = syncEnv ? envContentPresent : rootEnvFilePresent;
    if (contextDir && includeRootEnvFile) {
        const envPath = path.resolve(stackRoot, '.env');
        if (!isPathWithinBase(envPath, stackRoot)) {
            throw new Error(`Env file path escapes the stack directory for stack "${stackName}"`);
        }
        args.push('--env-file', envPath);
    }

    return args;
}
