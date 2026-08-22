/**
 * `undefined`-value handling for write payloads.
 *
 * TypeScript signals "absent" with `undefined`, and object spreads commonly
 * leave optional fields as `undefined` (`{ ...(x ? { a: x } : {}) }` patterns).
 * The MongoDB driver serializes explicit `undefined` as `null`, which then
 * violates a strict `$jsonSchema` validator (string/date/objectId fields
 * reject `null`). Stripping `undefined` keys — never `null` — makes "absent"
 * behave as absent on the wire.
 */

/** Strip `undefined` values from a document's own (top-level) keys, in place. */
export const stripUndefinedKeys = <T extends Record<string, unknown>>(doc: T): T => {
  for (const key of Object.keys(doc)) {
    if (doc[key] === undefined) {
      delete (doc as Record<string, unknown>)[key];
    }
  }
  return doc;
};

/**
 * Strip `undefined` values from an update payload: top-level plain-patch keys
 * AND nested values inside `$set` / `$setOnInsert` operator objects. Operator
 * forms beyond those two are left untouched (their semantics differ).
 */
export const stripUndefinedFromUpdate = <T>(update: T): T => {
  if (update === null || typeof update !== "object") return update;
  const doc = update as Record<string, unknown>;

  for (const operator of ["$set", "$setOnInsert"]) {
    const op = doc[operator];
    if (op !== null && typeof op === "object" && !Array.isArray(op)) {
      const opDoc = op as Record<string, unknown>;
      for (const key of Object.keys(opDoc)) {
        if (opDoc[key] === undefined) delete opDoc[key];
      }
    }
  }

  for (const key of Object.keys(doc)) {
    if (doc[key] === undefined) delete doc[key];
  }
  return update;
};
