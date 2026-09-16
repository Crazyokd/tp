import { validateCaseCatalog, validateCaseDocument, type CaseDefinition } from '@tp/contract';

import type { AdapterRegistry } from './adapter-registry.ts';

export function validateDefinition(definition: unknown, registry: AdapterRegistry): CaseDefinition {
  const validated = validateCaseDocument(definition);
  validateCaseCatalog(validated, registry.listAdapters());
  return validated;
}
