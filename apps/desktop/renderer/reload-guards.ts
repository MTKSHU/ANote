const guards = new Set<() => Promise<void>>();
let saving: Promise<void> | null = null;

export function registerReloadGuard(guard: () => Promise<void>) {
  guards.add(guard);
  return () => { guards.delete(guard); };
}

export function flushBeforeReload() {
  if (!saving) {
    const task = Promise.all([...guards].map(guard => guard())).then(() => {});
    saving = task;
    void task.finally(() => { if (saving === task) saving = null; }).catch(() => {});
  }
  return saving;
}
