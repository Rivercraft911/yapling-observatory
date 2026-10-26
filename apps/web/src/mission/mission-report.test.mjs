import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
async function load(name) {
  const source = await readFile(new URL(name, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}
const { setMissionDuration } = await load('./missionDuration.ts');
for (const days of [1, 7, 30]) {
  const config = {
    duration_s: 86400,
    clocks: {
      dynamics_step_s: 0.5,
      orbit_substeps: 2,
      controller_period_s: 2,
      thermal_step_s: 10,
      output_step_s: 30,
    },
    conops: { windows: [] },
  };
  const physical = structuredClone(config.clocks);
  setMissionDuration(config, days * 86400);
  assert.equal(config.duration_s, days * 86400);
  assert(config.duration_s / config.clocks.output_step_s <= 20000);
  for (const key of ['dynamics_step_s', 'orbit_substeps', 'controller_period_s', 'thermal_step_s'])
    assert.equal(config.clocks[key], physical[key]);
}
for (const [thermal, output, days] of [
  [8, 32, 30],
  [7.5, 30, 7],
  [10, 100000, 1],
]) {
  const config = {
    clocks: { dynamics_step_s: 0.5, thermal_step_s: thermal, output_step_s: output },
  };
  setMissionDuration(config, days * 86400);
  assert.equal(config.clocks.output_step_s % thermal, 0);
  assert.equal(config.duration_s % config.clocks.output_step_s, 0);
  assert(config.duration_s / config.clocks.output_step_s <= 20000);
  assert.equal(config.clocks.thermal_step_s, thermal);
}
const { reportCsv, reportMegabytes, missionReport } = await load('./missionReporting.ts');
assert.equal(reportMegabytes(null), '—');
assert.equal(reportMegabytes(8000000), '1');
assert.equal(missionReport(undefined), null);
const report = {
  schema_version: '1.0',
  days: [
    {
      date_utc: '2026-10-25',
      computed_duration_s: 300,
      partial_day: true,
      geometric_pass_count: 1,
      geometric_pass_entries: 0,
      geometric_visible_s: 120,
      scheduled_contact_s: 60,
      uplink: { ideal_capacity_bits: 8000000, delivered_useful_bits: null },
      downlink: { ideal_capacity_bits: 16000000, delivered_useful_bits: 10000000 },
    },
  ],
  passes: [],
};
assert.equal(missionReport(report), report);
assert.equal(missionReport({ ...report, passes: undefined }), null);
assert.deepEqual(missionReport({ ...report, passes: undefined }, true).passes, []);
const csv = reportCsv(report);
assert(csv.includes('uplink_modeled_payload_bits'));
assert(csv.includes('"8000000","16000000",,"10000000"'));
assert(csv.includes('"2026-10-25","300","1","1","0"'));
console.log(
  'Mission reports preserve missing delivery and keep duration presets independent of physical clocks.',
);
