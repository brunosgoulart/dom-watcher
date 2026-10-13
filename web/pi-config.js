/* Version: 1.0 | Date: 13/10/2026
Changes: Configured same-origin read-only PI status endpoint, polling interval and request timeout. */
'use strict';
const PI_API_CONFIG = Object.freeze({ statusUrl: '/api/v1/status', refreshMs: 10000, timeoutMs: 8000 });
