// Identity of the current agent run for computer use. The extension starts a
// run on each agent prompt, ends it on agent_settled (normal or aborted), and
// the host sends the runtime a turn_ended for the run, carrying this metadata.
// Host-logic file: must never import anything from pi. Zero dependencies.
import { randomBytes } from 'node:crypto';

// One id per host session (per extension lifetime). The real pi session id is
// injected after construction (SSOT: pi's SessionManager), this random one is
// only the fallback for hosts without a pi session manager.
export class TurnMeta {
  constructor() {
    this.sessionId = `pi-${process.pid}-${randomBytes(4).toString('hex')}`;
    this.turnId = null; // null until the first agent run begins
    this._turnSeq = 0;
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId;
  }

  // A new run begins: every cell in it carries this fresh id.
  beginRun() {
    this._turnSeq += 1;
    this.turnId = `${this.sessionId}-turn-${this._turnSeq}-${randomBytes(3).toString('hex')}`;
    return this.turnId;
  }

  // The run has ended (settled or aborted). A hook event on the runtime side
  // is the Stop/Interrupt Codex maps to turn_ended; the live run id is the
  // fallback when none arrives. After returning, `turnId` is null — the
  // "no active agent run" gate uses that.
  endRun() {
    const turnId = this.turnId;
    this.turnId = null;
    return turnId;
  }

  // The Codex-style metadata block every cell carries.
  cellMeta() {
    return { session_id: this.sessionId, turn_id: this.turnId };
  }
}