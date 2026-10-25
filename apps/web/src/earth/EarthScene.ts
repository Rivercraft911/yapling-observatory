import {
  BufferGeometry, Color, Float32BufferAttribute, Group, Line, LineBasicMaterial, LineDashedMaterial,
  LineSegments, Mesh, NoColorSpace, PerspectiveCamera, Points, PointsMaterial, REVISION, Scene,
  SRGBColorSpace, TextureLoader, LinearMipmapLinearFilter, LinearFilter, RepeatWrapping, ClampToEdgeWrapping, Vector3,
} from 'three';
import type { Texture } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { AssetInfo, RunSnapshot, Variant } from '../types';
import { createRenderer } from '../graphics/renderer';
import { createEarthAppearance } from './atmosphereAdapter';
import type { EarthAppearance } from './atmosphereAdapter';
import { earthGeometry } from './geometry';
import { SpacecraftFollow } from './SpacecraftFollow';
import type { FollowStatus } from './SpacecraftFollow';
import { ecefToDisplay, geodeticToEcef, isEarthOccluded, visualSunDirection, WGS84_A_M, WGS84_B_OVER_A } from './geodesy';

export interface EarthLabels {station:HTMLElement;satellite:HTMLElement}
export type EarthCameraMode='earth'|'spacecraft';
export class EarthScene {
  private readonly scene=new Scene();
  private readonly renderer=createRenderer().renderer;
  private readonly camera=new PerspectiveCamera(34,1,.001,40);
  private readonly controls:OrbitControls;
  private readonly follow:SpacecraftFollow;
  private readonly followEarthCamera=new PerspectiveCamera(34,1,.0001,40);
  private cameraMode:EarthCameraMode='earth';
  private readonly history=new Group();
  private readonly satelliteGeometry=new BufferGeometry().setAttribute('position',new Float32BufferAttribute([0,0,0],3));
  private readonly stationGeometry=new BufferGeometry().setAttribute('position',new Float32BufferAttribute([0,0,0],3));
  private readonly satelliteMaterial=new PointsMaterial({color:'#ef6771',size:6,sizeAttenuation:false,depthTest:true});
  private readonly stationMaterial=new PointsMaterial({color:'#e6e1d9',size:4,sizeAttenuation:false,depthTest:true});
  private readonly satellite=new Points(this.satelliteGeometry,this.satelliteMaterial);
  private readonly station=new Points(this.stationGeometry,this.stationMaterial);
  private readonly losGeometry=new BufferGeometry().setAttribute('position',new Float32BufferAttribute([0,0,0,0,0,0],3));
  private readonly losSolidMaterial=new LineBasicMaterial({color:'#ef6771',transparent:true,opacity:.85});
  private readonly losDashedMaterial=new LineDashedMaterial({color:'#e6e1d9',transparent:true,opacity:.8,dashSize:.018,gapSize:.012});
  private readonly losSolid=new Line(this.losGeometry,this.losSolidMaterial);
  private readonly losDashed=new Line(this.losGeometry,this.losDashedMaterial);
  private appearance:EarthAppearance|null=null;
  private textures:Texture[]=[];
  private earthMeshes:Mesh[]=[];
  private snapshot:RunSnapshot|null=null;
  private stationPoint=new Vector3();
  private sampleIndex=0;
  private stationNormal=new Vector3();
  private frame=0;
  private disposed=false;
  private observer:ResizeObserver;
  private autoFramed=false;
  private frameTimes:number[]=[];
  private lastFrame=0;

  constructor(private host:HTMLElement,private labels:EarthLabels,private onLoad:(error?:string)=>void,onFollowStatus?:(status:FollowStatus)=>void){
    this.scene.background=new Color('#060709');
    this.camera.position.set(-1.4,1.6,3.5);
    const canvas=this.renderer.domElement;canvas.tabIndex=0;canvas.className='earth-canvas';
    canvas.setAttribute('aria-label','Earth pass view. Drag to orbit, right-drag to pan, scroll to zoom.');
    canvas.dataset.renderer=`Three r${REVISION} / WebGL 2`;
    this.renderer.toneMappingExposure=1.08;
    this.host.appendChild(canvas);
    this.controls=new OrbitControls(this.camera,canvas);this.controls.enableDamping=true;this.controls.dampingFactor=.08;
    this.controls.minDistance=.06;this.controls.maxDistance=10;this.controls.zoomToCursor=true;
    this.follow=new SpacecraftFollow(this.renderer,canvas,status=>{canvas.dataset.followStatus=status.state;canvas.dataset.followRevision=status.revision;onFollowStatus?.(status);});
    this.follow.setEnabled(false);canvas.dataset.cameraMode='earth';
    this.scene.add(this.history,this.satellite,this.station,this.losSolid,this.losDashed);
    this.history.visible=false;this.satellite.visible=false;this.station.visible=false;this.losSolid.visible=false;this.losDashed.visible=false;
    this.observer=new ResizeObserver(()=>{
      const width=this.host.clientWidth,height=this.host.clientHeight;
      this.camera.aspect=width/Math.max(height,1);this.camera.updateProjectionMatrix();this.renderer.setSize(width,height);this.follow.setSize(width,height);
    });this.observer.observe(host);
    void this.load();this.frame=requestAnimationFrame(this.animate);
  }

  private async load(){
    const loader=new TextureLoader();
    const highResolution=this.renderer.capabilities.maxTextureSize>=8192;
    this.renderer.domElement.dataset.mapResolution=highResolution?'8192×4096':'4096×2048 GPU fallback';
    const urls=[highResolution?'/earth/earth-day-8k.jpg':'/earth/earth-day-4k.jpg',highResolution?'/earth/earth-clouds-8k.jpg':'/earth/earth-clouds-4k.png','/earth/earth-ocean-2k.png'];
    const results=await Promise.allSettled(urls.map(url=>loader.loadAsync(url)));
    const textures=results.flatMap(result=>result.status==='fulfilled'?[result.value]:[]);
    if(this.disposed||results.some(result=>result.status==='rejected')){
      textures.forEach(texture=>texture.dispose());
      if(!this.disposed)this.onLoad('Earth imagery unavailable');return;
    }
    this.textures=textures;
    textures.forEach((texture,i)=>{
      texture.colorSpace=i===0?SRGBColorSpace:NoColorSpace;texture.flipY=true;
      texture.wrapS=RepeatWrapping;texture.wrapT=ClampToEdgeWrapping;texture.minFilter=LinearMipmapLinearFilter;texture.magFilter=LinearFilter;
      texture.generateMipmaps=true;texture.anisotropy=Math.min(this.renderer.capabilities.getMaxAnisotropy(),16);texture.needsUpdate=true;
    });
    this.appearance=createEarthAppearance(textures[0],textures[1],textures[2]);
    const surface=new Mesh(earthGeometry(),this.appearance.surface);
    const clouds=new Mesh(earthGeometry(8000),this.appearance.clouds);clouds.renderOrder=1;
    const atmosphere=new Mesh(earthGeometry(80000,128,64),this.appearance.atmosphere);atmosphere.renderOrder=2;
    this.earthMeshes=[surface,clouds,atmosphere];this.scene.add(...this.earthMeshes);
    this.updateSample(this.sampleIndex);this.onLoad();
  }

  setHistory(snapshot:RunSnapshot|null){
    if(snapshot===this.snapshot)return;
    this.snapshot=snapshot;this.clearHistory();
    const samples=snapshot?.run.result?.samples;
    if(!snapshot||!samples?.satellite_position_ecef_m.length){this.history.visible=false;this.station.visible=false;this.satellite.visible=false;return;}
    const station=snapshot.scenario.station;
    this.stationPoint.fromArray(ecefToDisplay(geodeticToEcef(station.latitude_deg,station.longitude_deg,station.height_m)));
    const lat=station.latitude_deg*Math.PI/180,lon=station.longitude_deg*Math.PI/180;
    this.stationNormal.set(Math.cos(lat)*Math.cos(lon),Math.sin(lat),-Math.cos(lat)*Math.sin(lon));
    this.station.position.copy(this.stationPoint);
    const above:number[]=[],below:number[]=[];
    for(let i=1;i<samples.satellite_position_ecef_m.length;i++){
      const a=samples.satellite_position_ecef_m[i-1],b=samples.satellite_position_ecef_m[i];
      if(a?.length!==3||b?.length!==3||!a.every(Number.isFinite)||!b.every(Number.isFinite))continue;
      (samples.visible[i-1]&&samples.visible[i]?above:below).push(...ecefToDisplay(a),...ecefToDisplay(b));
    }
    for(const [vertices,color,opacity] of [[below,'#706b65',.34],[above,'#e6e1d9',.66]] as const){
      const geometry=new BufferGeometry().setAttribute('position',new Float32BufferAttribute(vertices,3));
      const line=new LineSegments(geometry,new LineBasicMaterial({color,transparent:true,opacity}));this.history.add(line);
    }
    this.history.visible=true;this.station.visible=true;
    this.renderer.domElement.dataset.runId=snapshot.run.run_id;
    if(!this.autoFramed){this.globe();this.autoFramed=true;}
    this.updateSample(this.sampleIndex);
  }

  updateSample(index:number){
    this.sampleIndex=index;
    const snapshot=this.snapshot,samples=snapshot?.run.result?.samples;
    const p=samples?.satellite_position_ecef_m[index];
    if(!snapshot||!samples||!p||p.length!==3||!p.every(Number.isFinite)){
      this.satellite.visible=false;this.losSolid.visible=false;this.losDashed.visible=false;
      this.labels.satellite.hidden=true;this.labels.station.hidden=true;return;
    }
    this.satellite.position.fromArray(ecefToDisplay(p));this.satellite.visible=true;
    const sun=visualSunDirection(snapshot.scenario.epoch_utc,samples.time_s[index]);
    this.appearance?.setSun(sun);this.follow.setSun(sun);this.follow.setPosition(p);
    const inertialStation=samples.station_position_m[index];
    const angle=inertialStation?.length===3?Math.atan2(-this.stationPoint.z,this.stationPoint.x)-Math.atan2(inertialStation[1],inertialStation[0]):undefined;
    const pose=samples.q_body_from_inertial_wxyz[index];
    if(pose)this.follow.setPose(pose,samples.time_s[index],snapshot.scenario.duration_s,angle);
    const position=this.losGeometry.getAttribute('position');
    position.setXYZ(0,this.station.position.x,this.station.position.y,this.station.position.z);
    position.setXYZ(1,this.satellite.position.x,this.satellite.position.y,this.satellite.position.z);position.needsUpdate=true;
    this.losGeometry.computeBoundingSphere();this.losDashed.computeLineDistances();
    const direction=samples.active_direction[index],margin=samples[direction]?.margin_db[index];
    const positive=samples.visible[index]&&margin!=null&&margin>=0;
    const color=positive?(direction==='uplink'?'#ef6771':'#e6e1d9'):samples.visible[index]?'#a77b51':'#77706b';
    this.losSolidMaterial.color.set(color);this.losDashedMaterial.color.set(color);
    this.losSolid.visible=positive&&direction==='uplink';this.losDashed.visible=!this.losSolid.visible;
    this.renderer.domElement.dataset.sampleIndex=String(index);
    this.renderer.domElement.dataset.elapsedSeconds=String(samples.time_s[index]);
  }

  setAsset(variant:Variant,asset?:AssetInfo){void this.follow.setAsset(variant,asset);}
  setCameraMode(mode:EarthCameraMode){
    this.cameraMode=mode;this.controls.enabled=mode==='earth';this.follow.setEnabled(mode==='spacecraft');
    this.renderer.domElement.dataset.cameraMode=mode;
    this.renderer.domElement.setAttribute('aria-label',mode==='earth'?'Earth pass view. Drag to orbit, right-drag to pan, scroll to zoom.':'Follow spacecraft. Drag to orbit the spacecraft; scroll to dolly. The spacecraft stays centered.');
  }
  resetFollow=()=>{this.follow.resetView();};

  globe=()=>{
    this.controls.target.set(0,0,0);
    if(this.snapshot){
      const east=new Vector3(this.stationNormal.z,0,-this.stationNormal.x).normalize();
      const vertical=this.camera.fov*Math.PI/360;const horizontal=Math.atan(Math.tan(vertical)*this.camera.aspect);
      const distance=1.28/Math.sin(Math.min(vertical,horizontal));
      this.camera.position.copy(this.stationNormal).addScaledVector(east,-.18).normalize().multiplyScalar(distance);
    }else this.camera.position.set(-1.4,1.6,3.5);
    this.camera.up.set(0,1,0);this.controls.update();
  };

  focusStation=()=>{
    if(!this.snapshot)return;
    const east=new Vector3(this.stationNormal.z,0,-this.stationNormal.x).normalize();
    const north=new Vector3().crossVectors(this.stationNormal,east).normalize();
    this.controls.target.copy(this.stationPoint).multiplyScalar(.90);
    this.camera.position.copy(this.stationPoint).addScaledVector(this.stationNormal,.95).addScaledVector(east,-.34).addScaledVector(north,.20);
    this.camera.up.copy(north);this.controls.update();
  };

  fitPass=()=>{
    if(!this.snapshot){this.globe();return;}
    // Camera framing changes no history, sample index or authoritative position.
    this.controls.target.copy(this.stationNormal).multiplyScalar(.50);
    const east=new Vector3(this.stationNormal.z,0,-this.stationNormal.x).normalize();
    this.camera.position.copy(this.stationNormal).multiplyScalar(3.0).addScaledVector(east,-.60);
    this.camera.up.set(0,1,0);this.controls.update();
  };

  private placeLabel(element:HTMLElement,position:Vector3,camera=this.camera){
    if(isEarthOccluded(camera.position.toArray(),position.toArray())){element.hidden=true;return;}
    const screen=position.clone().project(camera);
    element.hidden=screen.z>1||screen.z<-1||Math.abs(screen.x)>1||Math.abs(screen.y)>1;
    element.style.transform=`translate(${(screen.x*.5+.5)*this.host.clientWidth}px,${(-screen.y*.5+.5)*this.host.clientHeight}px)`;
  }

  private animate=(now:number)=>{
    if(this.disposed)return;
    const dt=this.lastFrame?Math.min(.1,(now-this.lastFrame)/1000):0;
    const follow=this.cameraMode==='spacecraft'&&!!this.snapshot?.run.result?.samples.satellite_position_ecef_m[this.sampleIndex];
    let activeCamera=this.camera;
    if(follow){
      this.follow.update(dt);this.clipFollowCamera();
      const local=this.follow.camera;
      this.followEarthCamera.position.copy(this.satellite.position).addScaledVector(local.position,1/WGS84_A_M);
      this.followEarthCamera.quaternion.copy(local.quaternion);this.followEarthCamera.up.copy(local.up);
      this.followEarthCamera.fov=local.fov;this.followEarthCamera.aspect=local.aspect;this.followEarthCamera.updateProjectionMatrix();this.followEarthCamera.updateMatrixWorld();
      activeCamera=this.followEarthCamera;this.satellite.visible=false;
    }else{
      this.controls.update();if(this.camera.position.length()<1.025)this.camera.position.setLength(1.025);
      this.satellite.visible=!!this.snapshot?.run.result?.samples.satellite_position_ecef_m[this.sampleIndex];
    }
    if(this.station.visible)this.placeLabel(this.labels.station,this.station.position,activeCamera);else this.labels.station.hidden=true;
    if(this.satellite.visible)this.placeLabel(this.labels.satellite,this.satellite.position,activeCamera);else this.labels.satellite.hidden=true;
    this.renderer.render(this.scene,activeCamera);
    if(follow){this.renderer.clearDepth();this.follow.render();}
    this.renderer.domElement.dataset.followModelVisible=String(follow&&this.follow.modelVisible);
    if(this.lastFrame){this.frameTimes.push(now-this.lastFrame);if(this.frameTimes.length===120){this.renderer.domElement.dataset.meanFrameMs=(this.frameTimes.reduce((a,b)=>a+b,0)/120).toFixed(2);this.frameTimes=[];}}
    this.lastFrame=now;this.frame=requestAnimationFrame(this.animate);
  };

  private clipFollowCamera(){
    // Keep the local camera on the spacecraft side of the opaque ellipsoid.
    // This is a view collision only; spacecraft/sample positions are never changed.
    const scale=WGS84_A_M, b=WGS84_B_OVER_A, origin=this.satellite.position;
    const offset=this.follow.camera.position;
    const ox=origin.x,oy=origin.y/b,oz=origin.z;
    const dx=offset.x/scale,dy=offset.y/(scale*b),dz=offset.z/scale;
    const a=dx*dx+dy*dy+dz*dz;if(a<1e-20)return;
    const q=2*(ox*dx+oy*dy+oz*dz),c=ox*ox+oy*oy+oz*oz-1.0002**2;
    const discriminant=q*q-4*a*c;if(discriminant<=0)return;
    const hit=(-q-Math.sqrt(discriminant))/(2*a);
    if(hit>0&&hit<1){offset.multiplyScalar(Math.max(0,hit*.999));this.follow.camera.lookAt(0,0,0);const distance=offset.length();this.follow.camera.near=Math.min(this.follow.camera.near,Math.max(.00005,distance*.25));this.follow.camera.far=Math.max(this.follow.camera.far,distance*1.5);this.follow.camera.updateProjectionMatrix();this.follow.camera.updateMatrixWorld();}
  }

  private clearHistory(){
    this.history.children.forEach(child=>{if(child instanceof LineSegments){child.geometry.dispose();(child.material as LineBasicMaterial).dispose();}});this.history.clear();
  }

  dispose(){
    this.disposed=true;cancelAnimationFrame(this.frame);this.observer.disconnect();this.controls.dispose();this.follow.dispose();this.clearHistory();
    this.earthMeshes.forEach(mesh=>mesh.geometry.dispose());this.appearance?.dispose();this.textures.forEach(texture=>texture.dispose());
    this.satelliteGeometry.dispose();this.stationGeometry.dispose();this.losGeometry.dispose();
    this.satelliteMaterial.dispose();this.stationMaterial.dispose();this.losSolidMaterial.dispose();this.losDashedMaterial.dispose();
    this.renderer.dispose();this.renderer.domElement.remove();
  }
}

export const EARTH_RENDER_SCALE_M=WGS84_A_M;
