// Process-local mutation locks shared by direct node actions and fleet-wide
// orchestration. Callers must use the same operation-specific key format.
export const activeBulkActions = new Set<string>();
