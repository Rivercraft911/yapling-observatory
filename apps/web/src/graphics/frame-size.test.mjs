import assert from 'node:assert/strict';
import { FrameSize } from './frameSize.ts';
const size = new FrameSize();
const calls = [];
const draw = () => {
  size.apply((w, h) => calls.push(['resize', w, h]));
  calls.push(['draw']);
};
size.request(800, 600);
size.request(920, 650);
assert.deepEqual(calls, []);
draw();
assert.deepEqual(calls, [['resize', 920, 650], ['draw']]);
size.request(920.4, 650.1);
size.request(0, 0);
draw();
assert.deepEqual(calls.at(-1), ['draw']);
assert.equal(calls.filter((c) => c[0] === 'resize').length, 1);
size.request(300, 400);
size.request(NaN, 600);
draw();
assert.deepEqual(calls.slice(-2), [['resize', 300, 400], ['draw']]);
console.log(
  'Frame-size checks passed: resize coalescing, same-frame redraw, stable sizes and hidden-host guards.',
);
