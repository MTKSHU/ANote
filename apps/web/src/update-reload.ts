const editingEvents = ["beforeinput", "input", "change", "compositionstart", "compositionend", "keydown", "pointerdown", "paste", "drop"];

/** Include edits made while asynchronous save operations are still pending. */
export async function saveBeforeReload(save: () => Promise<void>, events: EventTarget) {
  let revision = 0;
  const changed = () => { revision++; };
  for (const event of editingEvents) events.addEventListener(event, changed, true);
  try {
    while (true) {
      const captured = revision;
      await save();
      if (captured === revision) return;
    }
  } finally {
    for (const event of editingEvents) events.removeEventListener(event, changed, true);
  }
}
