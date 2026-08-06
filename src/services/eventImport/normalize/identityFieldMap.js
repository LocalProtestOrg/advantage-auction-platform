'use strict';

/**
 * identityFieldMap — a fieldMap that maps every canonical field to a same-named payload key.
 *
 * Live connectors (GSA, member feeds) do their source-specific parsing in code (where transforms like
 * date/timezone handling belong) and emit a payload already keyed by canonical field names. This map
 * lets the existing declarative normalizer pass those straight through, so no per-source field_map (and
 * no JS-in-JSONB) is needed. `images` is delivered on the raw record, not the payload, so it is omitted.
 */

const { CANONICAL_FIELDS } = require('./canonical');

const IDENTITY_FIELD_MAP = CANONICAL_FIELDS
  .filter((f) => f !== 'images')
  .reduce((m, f) => { m[f] = f; return m; }, {});

module.exports = { IDENTITY_FIELD_MAP };
