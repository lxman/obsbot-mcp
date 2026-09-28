// ---------------------------------------------------------------------------
// The single-camera lock, with a way to close it.
//
// Tool calls run strictly one at a time: the camera is one device and the XU
// selector-2 reply mailbox is a single shared slot, so two calls in flight at
// once would interleave on the wire. That part is unchanged from the old
// serialize() wrapper.
//
// What is new is close(). An owner that is handing the endpoint to a newer
// build must let the call that is RUNNING finish, and must stop every call that
// has not started — those belong to the new owner now. close() does both, and
// resolves once nothing is running.
// ---------------------------------------------------------------------------

/** Thrown to a call that had not started when the gate closed. */
export class StepDownError extends Error {
  constructor() {
    super("obsbot-mcp: this instance is handing the camera to a newer build");
    this.name = "StepDownError";
  }
}

export class CallGate {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;

  /** Run `fn` after every call queued before it. Rejects with StepDownError if the gate closes first. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => {
      if (this.closed) throw new StepDownError();
      return fn();
    });
    // Errors don't break the chain.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Refuse calls that have not started; resolve when the running one has finished. */
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
  }

  /** Accept calls again. */
  open(): void {
    this.closed = false;
  }
}
