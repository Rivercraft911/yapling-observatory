import assert from 'node:assert/strict';
import { ecefToDisplay, geodeticToEcef, textureUv, isEarthOccluded, visualSunDirection, WGS84_A_M, WGS84_B_OVER_A } from './geodesy.ts';
const near = (a,b,t=1e-10) => assert.ok(Math.abs(a-b)<t, `${a} != ${b}`);
const greenwich=ecefToDisplay(geodeticToEcef(0,0));
near(greenwich[0],1);near(greenwich[1],0);near(greenwich[2],0);
const east=ecefToDisplay(geodeticToEcef(0,90));near(east[0],0);near(east[2],-1);
const north=ecefToDisplay(geodeticToEcef(90,0));near(north[1],WGS84_B_OVER_A);
assert.deepEqual(textureUv(0,0),[.5,.5]);assert.deepEqual(textureUv(0,90),[.75,.5]);assert.deepEqual(textureUv(90,0),[.5,1]);
// Stanford is north of the equator, west of Greenwich and in the western-US map region.
const stanford=ecefToDisplay(geodeticToEcef(37.4275,-122.1697,30));
assert.ok(stanford[0]<0 && stanford[1]>0 && stanford[2]>0);
[-.4233395906362858,.6044391188176994,.6730409414785362].forEach((value,index)=>near(stanford[index],value,1e-13));
const uv=textureUv(37.4275,-122.1697);assert.ok(uv[0]>.15 && uv[0]<.17 && uv[1]>.70 && uv[1]<.72);
assert.equal(isEarthOccluded([0,0,3],[0,0,1.001]),false);
assert.equal(isEarthOccluded([0,0,3],[0,0,-1.1]),true);
assert.equal(isEarthOccluded([0,0,3],[2,0,0]),false);
const immutable=[WGS84_A_M,0,0];ecefToDisplay(immutable);assert.deepEqual(immutable,[WGS84_A_M,0,0]);
const sun=visualSunDirection('2000-01-01T12:00:00Z',0);near(Math.hypot(...sun),1);assert.ok(sun[0]>.9 && sun[1]<-.38);
console.log('Earth checks passed: ECEF handedness, WGS84, map UV, Stanford, occlusion, immutable input, visual Sun.');
