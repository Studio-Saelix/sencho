export * from './types';
export {
  parseComposeDocument, parseLabelFile, authoredScalarOf, diagnosticMessage, MAX_COMPOSE_PARSE_BYTES,
  authoredNodeKey, displayAuthoredPath,
} from './parseComposeDocument';
export type { ParsedComposeDocument, ParseComposeDocumentInput } from './parseComposeDocument';
export { resolveProjectInputs, stackRelativePath } from './resolveProjectInputs';
export type { ProjectChainFile, ProjectInputs } from './resolveProjectInputs';
export { buildAuthoredProject } from './buildAuthoredProject';
export { correlateField, correlateLabel, correlateVariableReference, resolveEditOrigin, normalizeForCompare } from './correlate';
export { locateFinding } from './locate';
