import type { FindStatus } from "./viewer-types";

/** The match count next to the find field: "3 of 12", "No matches", or nothing. */
export function findStatusLabel(find: FindStatus, query: string): string {
  if (!query || find.query !== query) return "";
  switch (find.state) {
    case "pending":
      return find.total > 0 ? `${find.current} of ${find.total}` : "…";
    case "not-found":
      return "No matches";
    case "found":
    case "wrapped":
      return find.total > 0 ? `${find.current} of ${find.total}` : "";
    default:
      return "";
  }
}
