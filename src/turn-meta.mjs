// Per-agent-run identity for computer-use (ticket #5): the pi session id plus
// an id unique to each agent run. Cells carry this as metadata so the host and
// the runtime agree on which "run" a cell belongs to; an Escape stop applies
// only to the current run and lifts when the next run begins.
// Host-logic file: must never import anything from pi. Zero dependencies.
import crypto from 'node:crypto';

export class TurnMeta {
  // sessionId identifies the pi session to the runtime; runId is regenerated
  // for each new agent run so an Escape stop doesn't leak across prompts.
  constructor(sessionId = newSessionId()) {
    this.sessionId = sessionId;
    this.runId = null;
    this._runCounter = 0;
  }

  // Begin a new agent run: fresh run id, Escape stop cleared.
  beginRun(context = {}) {
    this._runCounter += 1;
    this.runId = context.runId ?? `${this.sessionId}-run-${this._runCounter}-${crypto.randomBytes(4).toString('hex')}`;
    return this.runId;
  }

  // End the current run: returns the run id that ended so the runtime can be
  // told exactly which turn stopped.
  endRun() {
    const ended = this.runId;
    this.runId = null;
    return ended;
  }

  // Metadata attached to every computer-use cell, mirroring Codex's turn tag
  // (x-codex-turn-metadata): which session and which agent run this cell is in.
  cellMeta() {
    return { session_id: this.sessionId, run_id: this.runId };
  }

  get runActive() {
    return this.runId != null;
  }
}

function newSessionId() {
  return `pi-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
}
