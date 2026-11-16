const prefix = "anote:client-update-read:";
const memory = new Set<string>();
export const updateReadEvent = "anote-client-update-read";

export function isUpdateRead(id: string) {
  if (memory.has(id)) return true;
  try { return localStorage.getItem(prefix + id) === "true"; } catch { return false; }
}

export function markUpdateRead(id: string) {
  memory.add(id);
  try { localStorage.setItem(prefix + id, "true"); } catch {}
  window.dispatchEvent(new Event(updateReadEvent));
}
