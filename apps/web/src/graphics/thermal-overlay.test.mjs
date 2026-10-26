import assert from 'node:assert/strict';
import { Group, Mesh, BoxGeometry, MeshStandardMaterial } from 'three';
import { createThermalOverlay, thermalNodeForPart, temperatureColor } from './thermalOverlay.ts';

const root = new Group();
const battery = new Group();
battery.name = 'SSI_BATTERY_CASSETTE';
root.add(battery);
const cell = new Mesh(new BoxGeometry(), new MeshStandardMaterial({ color: '#237d43' }));
battery.add(cell);
const tracker = new Group();
tracker.name = 'SSI_STAR_TRACKER_REMOVABLE';
const sensor = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
tracker.add(sensor);
root.add(tracker);
const rail = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
rail.name = 'Primary_rail_|_X+';
root.add(rail);
const panel = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
panel.name = 'Solar_cell_1_|_active_face';
panel.userData.name = 'Solar cell 1 | active face';
root.add(panel);
const fingers = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
fingers.material.name = 'Very fine cell metallization';
root.add(fingers);
const before = [cell, sensor, rail, panel, fingers].map((mesh) => mesh.material);
assert.equal(thermalNodeForPart(cell), 'battery');
assert.equal(thermalNodeForPart(sensor), null);
assert.equal(thermalNodeForPart(rail), 'bus');
assert.equal(thermalNodeForPart(panel), 'panel');
const originalChildren = [...root.children];
cell.visible = false;
const overlay = createThermalOverlay(root);
overlay.update({ battery: 273.15, bus: 353.15, panel: 313.15, camera: 999 });
assert(cell.material.color.equals(temperatureColor(273.15)));
assert(rail.material.color.equals(temperatureColor(353.15)));
assert(panel.material.color.equals(temperatureColor(313.15)));
assert(sensor.material.color.equals(temperatureColor(undefined)));
assert.equal(fingers.material, before[4]);
assert.equal(cell.visible, false);
assert.deepEqual(root.children, originalChildren);
const temperatureMaterial = cell.material;
overlay.update({ battery: 333.15 });
assert.equal(cell.material, temperatureMaterial);
assert(cell.material.color.equals(temperatureColor(333.15)));
assert(rail.material.color.equals(temperatureColor(undefined)));
overlay.update();
assert.deepEqual(
  [cell, sensor, rail, panel, fingers].map((mesh) => mesh.material),
  before,
);
overlay.update({ battery: 310 });
let disposed = false;
temperatureMaterial.addEventListener('dispose', () => {
  disposed = true;
});
overlay.dispose();
assert(disposed);
assert.equal(cell.material, before[0]);
assert.equal(cell.visible, false);
for (const mesh of [cell, sensor, rail, panel, fingers]) {
  mesh.geometry.dispose();
  mesh.material.dispose();
}
console.log(
  'Thermal overlay: node ancestry, unknown neutral, temperatures, unchanged visibility, material restoration/disposal passed.',
);
