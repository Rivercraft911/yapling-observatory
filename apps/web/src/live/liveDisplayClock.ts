export interface LiveDisplayState {
  sessionId: string | undefined;
  firstTime: number;
  latestTime: number;
  running: boolean;
  speed: number;
  inspectedTime: number | null;
}

type Receipt = { wallTime: number; simulationTime: number };

/** Delayed presentation of received states. This clock never extrapolates a pose. */
export class LiveDisplayClock {
  bufferS = 1.5;
  private receipts: Receipt[] = [];
  private previous: LiveDisplayState | undefined;
  private playbackWallTime = 0;
  current = 0;

  advance(state: LiveDisplayState, wallTimeS: number): number {
    const latest = Math.max(state.firstTime, state.latestTime);
    const bounded = (time: number) => Math.max(state.firstTime, Math.min(latest, time));
    const previous = this.previous;
    this.previous = state;
    const reset =
      !previous ||
      previous.sessionId !== state.sessionId ||
      previous.running !== state.running ||
      previous.speed !== state.speed ||
      previous.inspectedTime !== state.inspectedTime ||
      latest < previous.latestTime ||
      this.current < state.firstTime;

    if (!state.running || state.inspectedTime !== null) {
      this.current = bounded(state.inspectedTime ?? latest);
      this.receipts = [];
      return this.current;
    }

    const last = this.receipts.at(-1);
    if (reset || !last || (latest > last.simulationTime && wallTimeS - last.wallTime > 3)) {
      this.receipts = [{ wallTime: wallTimeS, simulationTime: latest }];
      this.bufferS = 1.5;
      this.playbackWallTime = wallTimeS;
      this.current = latest;
      return this.current;
    }
    if (latest > last.simulationTime) {
      this.bufferS = Math.min(3, Math.max(this.bufferS, wallTimeS - last.wallTime + 0.5));
      this.receipts.push({ wallTime: wallTimeS, simulationTime: latest });
    }

    // Keep one received frontier on either side of the delayed wall clock.
    const delayedWallTime = Math.min(
      this.receipts.at(-1)!.wallTime,
      Math.max(this.playbackWallTime, wallTimeS - this.bufferS),
    );
    this.playbackWallTime = delayedWallTime;
    while (this.receipts.length > 2 && this.receipts[1].wallTime <= delayedWallTime)
      this.receipts.shift();
    const lower = this.receipts[0],
      upper = this.receipts[1];
    let time = lower.simulationTime;
    if (upper && delayedWallTime > lower.wallTime) {
      const fraction = Math.min(
        1,
        (delayedWallTime - lower.wallTime) / (upper.wallTime - lower.wallTime),
      );
      time += (upper.simulationTime - lower.simulationTime) * fraction;
    }
    this.current = bounded(time);
    return this.current;
  }
}
