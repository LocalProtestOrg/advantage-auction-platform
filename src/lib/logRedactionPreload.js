'use strict';
// Loaded with `node --require` into every background worker server.js forks, so worker log lines are redacted too.
require('./logRedaction').install();
