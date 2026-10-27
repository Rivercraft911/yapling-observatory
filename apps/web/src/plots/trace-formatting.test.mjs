import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import {
  formatAxisValues,
  formatElapsedSeconds,
  formatRateAxisValues,
  formatRateValue,
  formatValue,
  selectRateUnit,
} from './traceFormatting.ts';

for (const value of [null, undefined, NaN, Infinity, -Infinity]) {
  assert.equal(formatValue(value), '—');
}
assert.equal(formatValue(0), '0');
assert.equal(formatValue(-0), '0');
assert.equal(formatValue(12.345), '12.3');
assert.equal(formatValue(-12.345), '-12.3');
assert.equal(formatValue(1.2), '1.2');
assert.equal(formatValue(120), '120');
assert.equal(formatValue(0.012345), '0.0123');
assert.equal(formatValue(-2.345e-13), '-2.35e-13');
assert.equal(formatValue(2e-13), '2e-13');
assert.equal(formatValue(12_345_678), '1.23e7');
assert.equal(formatValue(-12_345_678), '-1.23e7');
assert.equal(formatValue(9999), '1e4');
assert.equal(formatValue(Number.MIN_VALUE), '4.94e-324');
assert.equal(formatValue(Number.MAX_VALUE), '1.8e308');
assert.equal(formatValue(12.3456789, 100), '12.345679');
assert.equal(formatValue(12.3456789, -100), '12');
assert.equal(formatValue(1.23456789e-13, NaN), '1.23e-13');

const tiny = [-4e-13, -2e-13, 0, 2e-13, 4e-13];
assert.deepEqual(formatAxisValues(tiny), ['-4e-13', '-2e-13', '0', '2e-13', '4e-13']);
for (const ticks of [
  tiny,
  [-0.000012, -0.000011, -0.00001, 0],
  [0.001001, 0.001002, 0.001003],
  [100.001, 100.002, 100.003],
  [1e8, 1.01e8, 1.02e8],
  [1.00001e12, 1.00002e12, 1.00003e12],
]) {
  const labels = formatAxisValues(ticks);
  assert.equal(new Set(labels).size, ticks.length, `${ticks}: ${labels}`);
  assert(
    labels.every((label) => label.length <= 13),
    `${labels}`,
  );
  assert(ticks.every((value, index) => value === 0 || Number(labels[index]) !== 0));
  assert(ticks.every((value, index) => Math.sign(value) === Math.sign(Number(labels[index]))));
}
assert.deepEqual(formatAxisValues([-10, 0, 10, 20]), ['-10', '0', '10', '20']);
assert.deepEqual(formatAxisValues([-0, 0, 1, 1]), ['0', '0', '1', '1']);
assert.deepEqual(formatAxisValues([]), []);
assert.deepEqual(formatAxisValues([NaN, Infinity]), ['—', '—']);
console.log(
  'Trace formatting passed: small/large scientific notation, bounded precision, distinct close ticks, signs, zero and unavailable values.',
);

// uPlot passes null before calculating the first tick labels, despite its declared type.
const component = await readFile(new URL('./TracePlot.tsx', import.meta.url), 'utf8');
const parsed = ts.createSourceFile(
  'TracePlot.tsx',
  component,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let sizing;
function visit(node) {
  if (
    ts.isPropertyAssignment(node) &&
    node.name.getText(parsed) === 'size' &&
    ts.isArrowFunction(node.initializer) &&
    node.initializer.parameters[1]?.name.getText(parsed) === 'labels'
  ) {
    sizing = node.initializer.getText(parsed);
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
assert(sizing, 'The y-axis must reserve room for formatted labels.');
const code = ts.transpileModule(`export const axisSize = ${sizing};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { axisSize } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
);
assert.equal(axisSize({}, null), 49);
assert.equal(axisSize({}, []), 49);
assert.equal(axisSize({}, ['-2e-13', '0', '2e-13']), 49);
assert(axisSize({}, ['-1.23456e-308']) > 80);
console.log(
  'Trace axis sizing passed: null-label initialization, ordinary width and long signed scientific labels.',
);

assert.equal(formatValue(1234.56, 0), '1235');
assert.equal(formatValue(12298, 0), '12298');
assert.equal(formatValue(12298.456, 2), '12298.46');
assert.equal(formatValue(12, 2), '12.00');
assert.equal(formatValue(12.3456, 2), '12.35');
assert.equal(formatElapsedSeconds(72930), '72930.0');
assert.equal(formatElapsedSeconds(2591999.8), '2591999.8');
assert.equal(formatElapsedSeconds(0), '0.0');
assert.equal(formatElapsedSeconds(null), '—');
assert.equal(formatElapsedSeconds(NaN), '—');
assert(component.includes('formatElapsedSeconds(times[index])'));
console.log(
  'Elapsed time and explicit decimal formatting passed: day/month timestamps retain 0.1 s resolution and existing range rounding is preserved.',
);

const rates = Object.freeze([0, null, 26700, 0.5]);
assert.deepEqual(selectRateUnit('kb/s', [rates]), { unit: 'Mb/s', divisor: 1000 });
assert.equal(formatRateValue(rates[2] / 1000), '26.7');
assert.deepEqual(selectRateUnit('kb/s', [rates, [2000000]]), {
  unit: 'Gb/s',
  divisor: 1000000,
});
assert.deepEqual(selectRateUnit('b/s', [[9600]]), { unit: 'kb/s', divisor: 1000 });
assert.deepEqual(selectRateUnit('kb/s', [[0.25, null]]), { unit: 'b/s', divisor: 0.001 });
assert.deepEqual(selectRateUnit('Mb/s', [[-2.5]]), { unit: 'Mb/s', divisor: 1 });
for (const values of [[], [null, NaN, Infinity], [0, -0, null]])
  assert.deepEqual(selectRateUnit('kb/s', [values]), { unit: 'kb/s', divisor: 1 });
assert.equal(selectRateUnit('W', [rates]), null);
assert.equal(formatRateValue(0), '0');
assert.equal(formatRateValue(-0), '0');
assert.equal(formatRateValue(null), '—');
assert.equal(formatRateValue(NaN), '—');
assert.equal(formatRateValue(0.0005), '0.0005');
assert.equal(formatRateValue(0.000000125), '0.000000125');
assert.equal(formatRateValue(-12.345), '-12.3');
assert.deepEqual(formatRateAxisValues([0, 5, 10, 15]), ['0', '5', '10', '15']);
assert.deepEqual(formatRateAxisValues([0.000101, 0.000102, 0.000103]), [
  '0.000101',
  '0.000102',
  '0.000103',
]);
assert.deepEqual(rates, [0, null, 26700, 0.5]);
console.log(
  'Rate formatting passed: one decimal SI unit across current/comparison samples, stable empty/zero units, decimal rate labels, nulls and immutable input values.',
);
