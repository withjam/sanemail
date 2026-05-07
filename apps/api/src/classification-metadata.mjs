/**
 * Normalizes message_classifications.action_metadata (jsonb) into the API shape
 * for recent-classification rows.
 */
export function normalizeClassificationExtracted(raw) {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    actions: Array.isArray(o.actions) ? o.actions.filter((x) => typeof x === "string") : [],
    deadlines: Array.isArray(o.deadlines) ? o.deadlines.filter((x) => typeof x === "string") : [],
    entities: Array.isArray(o.entities) ? o.entities.filter((x) => typeof x === "string") : [],
    replyCue: typeof o.replyCue === "string" && o.replyCue.trim() ? o.replyCue.trim() : null,
  };
}
