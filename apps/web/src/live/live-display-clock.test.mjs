import assert from 'node:assert/strict';
import { LiveDisplayClock } from './liveDisplayClock.ts';
import { displayBracket } from '../graphics/displayInterpolation.ts';

const near = (actual, expected, tolerance = 1e-10) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const state = (latestTime, patch = {}) => ({
  sessionId: 'live-a',
  firstTime: 0,
  latestTime,
  running: true,
  speed: 1,
  inspectedTime: null,
  ...patch,
});

// Actual 1 Hz returned states presented at 60 Hz must advance evenly between
// receipts, including the frame that accepts the next state.
for (const frameHz of [30, 60, 144]) {
  const clock = new LiveDisplayClock();
  let previous = 0;
  for (let frame = 0; frame <= frameHz * 10; frame++) {
    const wall = frame / frameHz;
    const latest = Math.floor(wall);
    const shown = clock.advance(state(latest), wall);
    assert.ok(shown >= previous && shown <= latest);
    if (wall > clock.bufferS) {
      near(shown, wall - clock.bufferS);
      if (wall > clock.bufferS + 1 / frameHz) near(shown - previous, 1 / frameHz);
      const bracket = displayBracket(
        Array.from({ length: latest + 1 }, (_, i) => i),
        shown,
      );
      assert.ok(bracket.lower <= bracket.upper && bracket.upper <= latest);
    }
    previous = shown;
  }
}

// The compatible 2 s numerical step can return states less often than the
// minimum buffer. Learn that receipt cadence once without rewinding a pose.
for (const receiptPeriod of [2, 2.5]) {
  const clock = new LiveDisplayClock();
  let previous = 0;
  for (let frame = 0; frame <= 600; frame++) {
    const wall = frame / 60;
    const latest = Math.floor(wall / receiptPeriod) * receiptPeriod;
    const shown = clock.advance(state(latest), wall);
    assert.ok(shown >= previous && shown <= latest);
    assert.ok(clock.bufferS >= 1.5 && clock.bufferS <= 3);
    if (wall > receiptPeriod + 0.5) {
      near(shown, wall - clock.bufferS);
      near(shown - previous, 1 / 60);
    }
    previous = shown;
  }
}

// Poll jitter changes the measured receipt slope, but does not jump at a new
// receipt or outrun accepted telemetry. Requested speed is not a propagation clock.
const receipts = [0, 1.13, 2.07, 3.31, 4.22, 5.1, 6.28, 7.2, 8.18, 9.1];
for (const [requestedSpeed, actualRate] of [
  [1, 1],
  [60, 60],
  [1000, 20],
]) {
  const clock = new LiveDisplayClock();
  let receipt = 0,
    previous = 0,
    previousWall = 0;
  for (let frame = 0; frame <= 600; frame++) {
    const wall = frame / 60;
    while (receipt + 1 < receipts.length && receipts[receipt + 1] <= wall) receipt++;
    const latest = receipt * actualRate;
    const shown = clock.advance(state(latest, { speed: requestedSpeed }), wall);
    assert.ok(shown >= previous && shown <= latest);
    assert.ok(shown - previous <= (wall - previousWall) * actualRate * 1.2 + 1e-9);
    if (wall >= 2 && wall <= 9) assert.ok(latest - shown < actualRate * 2);
    previous = shown;
    previousWall = wall;
  }
}

const clock = new LiveDisplayClock();
clock.advance(state(0), 0);
clock.advance(state(1), 1);
near(clock.advance(state(2), 2), 0.5);
// Pause, scrubbing and Now resolve to returned times immediately. No easing or
// residual rate from a previous mode may keep moving a paused/inspected pose.
near(clock.advance(state(2, { running: false }), 2.1), 2);
near(clock.advance(state(2, { running: false }), 20), 2);
near(clock.advance(state(2, { inspectedTime: 0.37 }), 20.1), 0.37);
near(clock.advance(state(2, { inspectedTime: 0.37 }), 21), 0.37);
near(clock.advance(state(2), 22), 2);
near(clock.advance(state(3), 23), 2);
near(clock.advance(state(4), 24), 2.5);
near(clock.advance(state(4, { speed: 60 }), 24.1), 4);
near(clock.advance(state(34, { speed: 60 }), 24.6), 4);
near(clock.advance(state(64, { speed: 60 }), 25.1), 4);
near(clock.advance(state(94, { speed: 60 }), 25.6), 4);
near(clock.advance(state(124, { speed: 60 }), 26.1), 34);
near(clock.advance(state(124, { speed: 60, running: false }), 26.2), 124);

// Session replacement, gaps, lost service and completion cannot retain an old
// session's presentation queue or create states past the received endpoint.
near(clock.advance(state(0, { sessionId: 'live-b' }), 30), 0);
near(clock.advance(state(1, { sessionId: 'live-b' }), 31), 0);
near(clock.advance(state(20, { sessionId: 'live-b', firstTime: 19 }), 40), 20);
near(clock.advance(state(20, { sessionId: 'live-b', running: false }), 41), 20);
near(clock.advance(state(8, { sessionId: 'live-b', running: false }), 42), 8);
near(clock.advance(state(8, { inspectedTime: -50, running: false }), 43), 0);
near(clock.advance(state(8, { inspectedTime: 50, running: false }), 44), 8);
const stalled = new LiveDisplayClock();
stalled.advance(state(0), 0);
stalled.advance(state(1), 1);
for (let wall = 2; wall <= 10; wall++) assert.ok(stalled.advance(state(1), wall) <= 1);
near(stalled.advance(state(10), 10.1), 10);
near(stalled.advance(state(11), 11.1), 10);
console.log(
  'Live presentation passed: uniform 30/60/144 Hz frames from 1 Hz states, receipt jitter and CPU-limited rates, bounded returned-state interpolation, pause/seek/Now/rate/session/gap/terminal resets.',
);
