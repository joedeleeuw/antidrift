export const PHASES = ["queued", "done"] as const;
export const CODES = [-1, 0, 2] as const;
const labels = ["small", "large"] as const;
export { labels as LABELS };
export default labels;
