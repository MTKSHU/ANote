// The updater owns release/download state; this scheduler only controls when
// discovery runs. Manual checks and a changed connection take effect promptly.
export class UpdateChecks {
  constructor({ check, snapshot, contextKey, now = Date.now, interval = 5 * 60_000, retry = 30_000 }) {
    Object.assign(this, { check, snapshot, contextKey, now, interval, retry });
    this.lastAttempt = -Infinity;
    this.lastKey = null;
    this.failed = false;
    this.inflight = null;
  }
  run({ force = false, event = false } = {}) {
    if (this.inflight) return this.inflight;
    const key = this.contextKey();
    const delay = event || this.failed ? this.retry : this.interval;
    if (!force && key === this.lastKey && this.now() - this.lastAttempt < delay)
      return Promise.resolve(this.snapshot());
    this.lastAttempt = this.now();
    this.lastKey = key;
    this.inflight = Promise.resolve().then(() => this.check()).then(state => {
      this.failed = state?.status === "error";
      return state;
    }, error => {
      this.failed = true;
      throw error;
    }).finally(() => { this.inflight = null; });
    return this.inflight;
  }
}
