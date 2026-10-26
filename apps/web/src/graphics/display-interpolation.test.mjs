import assert from 'node:assert/strict';
import {
  advanceDisplayTime,
  displayBracket,
  interpolateQuaternion,
  interpolateVector3,
} from './displayInterpolation.ts';
import { ecefToDisplay } from '../earth/geodesy.ts';

const near = (a, b, tolerance = 1e-12) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const rotationZ = (degrees) => [
  Math.cos((degrees * Math.PI) / 360),
  0,
  0,
  Math.sin((degrees * Math.PI) / 360),
];
const angle = (q) => (2 * Math.atan2(q[3], q[0]) * 180) / Math.PI;
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const times = Object.freeze([0, 1, 3, 8]);
assert.equal(displayBracket([], 1), null);
assert.deepEqual(displayBracket(times, -5), { lower: 0, upper: 0, alpha: 0, time: 0, nearest: 0 });
assert.deepEqual(displayBracket(times, 20), { lower: 3, upper: 3, alpha: 0, time: 8, nearest: 3 });
assert.deepEqual(displayBracket(times, 3), { lower: 2, upper: 2, alpha: 0, time: 3, nearest: 2 });
assert.deepEqual(displayBracket(times, 2), { lower: 1, upper: 2, alpha: 0.5, time: 2, nearest: 2 });
assert.equal(displayBracket(times, 1.4).nearest, 1);
assert.equal(displayBracket(times, NaN).time, 0);
const first = Object.freeze([7e6, -4e6, 2e6]),
  last = Object.freeze([7.001e6, -4.002e6, 2.003e6]);
assert.deepEqual(interpolateVector3(first, last, 0), first);
assert.deepEqual(interpolateVector3(first, last, 1), last);
assert.deepEqual(interpolateVector3(first, last, 0.5), [7.0005e6, -4.001e6, 2.0015e6]);
const middleDisplay = ecefToDisplay(interpolateVector3(first, last, 0.3));
const firstDisplay = ecefToDisplay(first),
  lastDisplay = ecefToDisplay(last);
interpolateVector3(firstDisplay, lastDisplay, 0.3).forEach((value, i) =>
  near(value, middleDisplay[i]),
);
assert.equal(interpolateVector3(first, undefined, 0.5), null);
assert.equal(interpolateVector3(first, [NaN, 0, 0], 0.5), null);
assert.equal(interpolateVector3(first, last, NaN), null);
const q0 = Object.freeze(rotationZ(0)),
  q90 = Object.freeze(rotationZ(90));
assert.deepEqual(interpolateQuaternion(q0, q90, 0), q0);
assert.deepEqual(interpolateQuaternion(q0, q90, 1), q90);
near(angle(interpolateQuaternion(q0, q90, 0.5)), 45);
near(angle(interpolateQuaternion(q0, rotationZ(350), 0.5)), -5);
const antipodal = Object.freeze(q90.map((value) => -value));
for (const alpha of [0, 0.01, 0.25, 0.5, 0.75, 0.99, 1]) {
  const q = interpolateQuaternion(q90, antipodal, alpha);
  near(Math.abs(dot(q, q90)), 1);
  near(Math.hypot(...q), 1);
}
near(
  angle(
    interpolateQuaternion(
      [2, 0, 0, 0],
      rotationZ(90).map((x) => x * 3),
      0.5,
    ),
  ),
  45,
);
assert.equal(interpolateQuaternion([0, 0, 0, 0], q0, 0.5), null);
assert.equal(interpolateQuaternion(q0, undefined, 0.5), null);
assert.equal(interpolateQuaternion(q0, q90, NaN), null);
// A1x second contains60distinct display positions/rotations, not one integer pose jump.
let time = 0;
const positions = [],
  angles = [];
const input = JSON.stringify({ times, first, last, q0, q90 });
for (let frame = 0; frame < 60; frame++) {
  time = advanceDisplayTime(time, 1 / 60, 1, 8);
  const bracket = displayBracket(times, time);
  const fraction = time;
  positions.push(interpolateVector3(first, last, fraction)[0]);
  angles.push(angle(interpolateQuaternion(q0, q90, fraction)));
  assert.ok(bracket.time >= 0 && bracket.time <= 1.00000001);
}
assert.equal(new Set(positions).size, 60);
assert.equal(new Set(angles).size, 60);
near(time, 1);
for (let i = 1; i < angles.length; i++) near(angles[i] - angles[i - 1], 1.5, 1e-10);
assert.equal(JSON.stringify({ times, first, last, q0, q90 }), input);
// Rate changes continue from fractional time; an explicit scrub can use an exact sample.
near(advanceDisplayTime(0.37, 0.1, 2, 8), 0.57);
near(advanceDisplayTime(0.37, 0.1, 0.25, 8), 0.395);
assert.equal(advanceDisplayTime(7.95, 0.1, 1000, 8), 8);
assert.equal(advanceDisplayTime(0.37, -1, 1, 8), 0.37);
let slow = 0;
for (let i = 0; i < 240; i++) slow = advanceDisplayTime(slow, 1 / 60, 0.25, 8);
near(slow, 1);
const pin = displayBracket(times, 1.4).nearest;
assert.equal(times[pin], 1);
console.log(
  'Display interpolation checks passed: exact/irregular endpoints, coordinate consistency, shortest/antipodal SLERP,60subsecond poses at1x,rate continuity,missing-data guards and immutable input.',
);
