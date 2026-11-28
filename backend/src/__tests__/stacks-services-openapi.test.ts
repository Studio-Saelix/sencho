/**
 * The published API reference names every response the service lookup answers.
 *
 * The route gained a structured 409 refusal and a 413 size refusal; a consumer
 * reading docs/openapi.yaml must be able to tell them from a generic 500.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parse } from 'yaml';

interface Spec {
  paths: Record<string, Record<string, {
    responses?: Record<string, {
      $ref?: string;
      content?: Record<string, { schema?: { $ref?: string } }>;
    }>;
  }>>;
  components: {
    responses: Record<string, {
      content?: Record<string, {
        schema?: {
          required?: string[];
          properties?: Record<string, { enum?: string[] }>;
        };
      }>;
    }>;
  };
}

const spec = parse(
  fs.readFileSync(path.resolve(__dirname, '../../../docs/openapi.yaml'), 'utf8'),
) as Spec;

describe('docs/openapi.yaml: getStackServices', () => {
  const operation = spec.paths['/api/stacks/{stackName}/services'].get;

  it('documents the compose refusal as its own 409 envelope', () => {
    expect(operation.responses?.['409']?.$ref).toBe('#/components/responses/ComposeInputsRefused');

    const refusal = spec.components.responses.ComposeInputsRefused;
    const schema = refusal.content?.['application/json']?.schema;
    expect(schema?.required).toEqual(['error', 'code']);
    expect(schema?.properties?.code?.enum).toEqual(['compose_inputs_refused']);
  });

  it('documents the 1 MiB size refusal as a 413', () => {
    const tooLarge = operation.responses?.['413'];
    expect(tooLarge).toBeDefined();
    expect(tooLarge?.content?.['application/json']?.schema?.$ref).toBe('#/components/schemas/Error');
  });
});
