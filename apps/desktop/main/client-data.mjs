import path from "node:path";
import { existsSync } from "node:fs";

// App naming must not move existing credentials or personal-directory pointers.
export function clientDataRoot(appData, current, explicit, {preview = false} = {}) {
  if (explicit) return path.resolve(explicit);
  if (preview) return path.join(appData, "ANote-Preview");
  const hasProfile = directory => ["settings.json", "personal-mode.json"].some(file => existsSync(path.join(directory,file)));
  if (hasProfile(current)) return current;
  return ["SimpleNote", "ANote", "anote-desktop"].map(name=>path.join(appData,name)).find(hasProfile) || current;
}
