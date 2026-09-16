import { writeFileSync } from 'node:fs';

import { generateOpenApi } from './openapi.ts';

writeFileSync(new URL('../openapi.json', import.meta.url), `${JSON.stringify(generateOpenApi(), null, 2)}\n`);
