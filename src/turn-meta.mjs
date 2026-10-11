// Identity of the current agent run for computer use. The extension starts a
// run on each agent prompt, ends it on agent_settled (normal or aborted), and
// the host sends the runtime a turn_ended for the run, carrying this metadata.
// Host-logic file: must never import anything from pi. Zero dependencies.
import { randomBytes } from 'node:crypto';

export class TurnMeta {
  constructor() {
    // One id per host session (per extension lifetime).
    this.sessionId = `pi-${process.pid}-${randomBytes(4).toString('hex')}`;
    this.runId = null; // null until the first agent run begins
    this._runSeq = 0;
  }

  // A new run begins: every cell in it carries this fresh id.
  beginRun() {
    this._runSeq += 1;
    this.runId = `${this.sessionId}-run-${this._runSeq}-${randomBytes(3).toString('hex')}`;
    return this.runId;
  }

  // The run has ended (settled or aborted). Escape usually does not carry pi's
  // turn id, and our run id is our own; the live run must end regardless, so
  // fall back to it when no id arrives. After returning, `runId` is null and
  // `runActive` is false — the "no active agent run" gate uses that, while
  // the host still uses the stopped id to refuse later cells from the run.
  endRun(settledTurnId) {
    const run =
      settledTurnId && settledTurnId === this.runId
        ? settledTurnId
        : this.runId;
    this.runId = null;
    return run;
  }

  get runActive() {
    return this.runId != null;
  }

  // The Codex-style metadata block every cell carries.
  cellMeta() {
    return { session_id: this.sessionId, run_id: this.runId };
  }
}
