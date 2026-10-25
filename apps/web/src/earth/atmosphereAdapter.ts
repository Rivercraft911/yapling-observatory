import { AdditiveBlending, BackSide, ShaderMaterial, Vector3, Vector4 } from 'three';
import type { Texture } from 'three';
import type { CloudTileView } from './CloudTiles';

// Independent compatibility implementation. Replace this boundary with Takram's
// renderer-context/TSL atmosphere API when the app adopts that pipeline.
export interface EarthAppearance {
  surface: ShaderMaterial;
  clouds: ShaderMaterial;
  atmosphere: ShaderMaterial;
  setSun: (direction: readonly number[]) => void;
  setRegionalMap: (texture: Texture | null, bounds?: readonly number[]) => void;
  setRegionalOpacity: (opacity: number) => void;
  setCloudTiles: (tiles: readonly CloudTileView[]) => void;
  dispose: () => void;
}
const vertex = `
varying vec2 vUv;varying vec3 vPosition;varying vec3 vNormal;
void main(){vUv=uv;vPosition=(modelMatrix*vec4(position,1.)).xyz;vNormal=normalize(mat3(modelMatrix)*normal);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}
`;
function cloudSampling(tileCount: number) {
  const samples = Array.from(
    { length: tileCount },
    (_, index) => `
 if(nativeCloudOpacity[${index}]>0.){
  vec4 bounds=nativeCloudBounds[${index}];
  float u=uv.x+floor((bounds.x+bounds.z)*.5-uv.x+.5);
  vec2 localUv=(vec2(u,uv.y)-bounds.xy)/(bounds.zw-bounds.xy);
  float edge=min(min(localUv.x,localUv.y),min(1.-localUv.x,1.-localUv.y));
  if(edge>=0.){
   vec4 distance=vec4(localUv,1.-localUv);
   vec4 feather=mix(vec4(1.),smoothstep(vec4(0.),vec4(.07),distance),nativeCloudFeather[${index}]);
   float blend=nativeCloudOpacity[${index}]*feather.x*feather.y*feather.z*feather.w;
   float tile=texture2DGradEXT(nativeCloudMaps[${index}],localUv,dx/(bounds.zw-bounds.xy),dy/(bounds.zw-bounds.xy)).r;
   base=mix(base,tile,blend);
  }
 }`,
  ).join('');
  return `
uniform sampler2D cloudMap;
${
  tileCount
    ? `uniform sampler2D nativeCloudMaps[${tileCount}];
uniform vec4 nativeCloudBounds[${tileCount}];uniform vec4 nativeCloudFeather[${tileCount}];
uniform float nativeCloudOpacity[${tileCount}];`
    : ''
}
float cloudCoverage(vec2 uv){
 // Explicit derivatives remain valid across geographic branches and longitude wrap.
 vec2 dx=dFdx(uv),dy=dFdy(uv);dx.x-=floor(dx.x+.5);dy.x-=floor(dy.x+.5);
 float base=texture2DGradEXT(cloudMap,uv,dx,dy).r;
${samples}
 return base;
}
`;
}
export function createEarthAppearance(
  day: Texture,
  cloud: Texture,
  ocean: Texture,
  cloudTileCount = 0,
): EarthAppearance {
  const sun = { value: new Vector3(1, 0, 0) };
  const cloudUniforms = {
    cloudMap: { value: cloud },
    nativeCloudMaps: { value: Array.from({ length: cloudTileCount }, () => cloud) },
    nativeCloudBounds: {
      value: Array.from({ length: cloudTileCount }, () => new Vector4(0, 0, 1, 1)),
    },
    nativeCloudFeather: {
      value: Array.from({ length: cloudTileCount }, () => new Vector4(1, 1, 1, 1)),
    },
    nativeCloudOpacity: { value: new Float32Array(cloudTileCount) },
  };
  const uniforms = {
    sun,
    ...cloudUniforms,
    dayMap: { value: day },
    oceanMap: { value: ocean },
    regionalDayMap: { value: day },
    regionalBounds: { value: new Vector4(0, 0, 1, 1) },
    regionalOpacity: { value: 0 },
  };
  const surface = new ShaderMaterial({
    uniforms,
    vertexShader: vertex,
    fragmentShader: `
uniform sampler2D dayMap;uniform sampler2D oceanMap;uniform vec3 sun;
${cloudSampling(cloudTileCount)}
uniform sampler2D regionalDayMap;uniform vec4 regionalBounds;uniform float regionalOpacity;
varying vec2 vUv;varying vec3 vPosition;varying vec3 vNormal;
const float PI=3.141592653589793;
vec2 directionUv(vec3 p){vec3 n=normalize(vec3(p.x,p.y/0.9933056200,p.z));return vec2(atan(-n.z,n.x)/(2.*PI)+.5,asin(clamp(n.y,-1.,1.))/PI+.5);}
void main(){
 vec3 n=normalize(vNormal);vec3 view=normalize(cameraPosition-vPosition);float ndl=dot(n,sun);float water=texture2D(oceanMap,vUv).r;
 vec3 albedo=texture2D(dayMap,vUv).rgb;
 vec2 regionalUv=(vUv-regionalBounds.xy)/(regionalBounds.zw-regionalBounds.xy);
 float edge=min(min(regionalUv.x,regionalUv.y),min(1.-regionalUv.x,1.-regionalUv.y));
 float regionalMix=regionalOpacity*smoothstep(0.,.07,edge);
 if(regionalOpacity>0.){
  vec3 regional=texture2D(regionalDayMap,clamp(regionalUv,0.,1.)).rgb;
  albedo=mix(albedo,regional,regionalMix);
 }
 float luminance=dot(albedo,vec3(.2126,.7152,.0722));albedo=mix(vec3(luminance),albedo,.83);
 albedo*=mix(.93,.48,water);float direct=smoothstep(-.025,.10,ndl)*max(ndl,0.);
 vec2 shadowUv=directionUv(vPosition+sun*(.00125/max(ndl,.16)));
 float shadow=cloudCoverage(shadowUv)*.26;
 vec3 color=albedo*(.003+direct*1.65*(1.-shadow));
 vec3 halfVector=normalize(sun+view);float specular=pow(max(dot(n,halfVector),0.),100.)*water*smoothstep(0.,.15,ndl);
 float fresnel=.025+.975*pow(1.-max(dot(n,view),0.),5.);
 color+=vec3(1.,.91,.77)*specular*fresnel*1.8;
 float grazing=pow(1.-max(dot(n,view),0.),3.);color+=vec3(.015,.045,.085)*grazing*smoothstep(-.15,.35,ndl);
 gl_FragColor=vec4(color,1.);
 #include <tonemapping_fragment>
 #include <colorspace_fragment>
}`,
  });
  const clouds = new ShaderMaterial({
    uniforms: { sun, ...cloudUniforms },
    vertexShader: vertex,
    transparent: true,
    depthWrite: false,
    // Linear coverage commutes with mip filtering; a post-filter threshold loses wisps at distance.
    fragmentShader: `
${cloudSampling(cloudTileCount)}
uniform vec3 sun;varying vec2 vUv;varying vec3 vPosition;varying vec3 vNormal;
void main(){float density=cloudCoverage(vUv);float opacity=density*.94;float ndl=dot(normalize(vNormal),sun);float light=smoothstep(-.035,.08,ndl)*pow(max(ndl,0.),.52);
vec3 color=vec3(.99,.99,1.)*(.008+light*1.4);gl_FragColor=vec4(color,opacity);
 #include <tonemapping_fragment>
 #include <colorspace_fragment>
}`,
  });
  const atmosphere = new ShaderMaterial({
    uniforms: { sun },
    vertexShader: vertex,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: BackSide,
    blending: AdditiveBlending,
    fragmentShader: `
uniform vec3 sun;varying vec3 vPosition;const float R=6378.137;const float PI=3.141592653589793;
vec2 intersectSphere(vec3 o,vec3 d,float radius){float b=dot(o,d),c=dot(o,o)-radius*radius,h=b*b-c;if(h<0.)return vec2(1e5,-1e5);float s=sqrt(h);return vec2(-b-s,-b+s);}
void main(){
 vec3 axes=vec3(1.,.9966471893,1.);vec3 ro=cameraPosition/axes;vec3 rd=normalize((vPosition-cameraPosition)/axes);vec3 light=normalize(sun/axes);
 vec2 hit=intersectSphere(ro,rd,1.01255);float start=max(hit.x,0.);float end=hit.y;vec2 ground=intersectSphere(ro,rd,1.);if(ground.x>0.)end=min(end,ground.x);if(end<=start)discard;
 float stepSize=(end-start)/32.;vec2 optical=vec2(0.);vec3 scatter=vec3(0.);vec3 betaR=vec3(.0058,.0135,.0331);vec3 betaM=vec3(.003);
 float mu=dot(rd,light);float phaseR=3./(16.*PI)*(1.+mu*mu);float g=.76;float phaseM=(1.-g*g)/(4.*PI*pow(1.+g*g-2.*g*mu,1.5));
 for(int i=0;i<32;i++){
  vec3 p=ro+rd*(start+(float(i)+.5)*stepSize);float altitude=max(0.,(length(p)-1.)*R);vec2 density=exp(-altitude/vec2(8.,1.2));vec2 local=density*stepSize*R;optical+=local;
  // A finite solar disk gives continuous illumination at the geometric horizon.
  // Optical depth above is still accumulated for every view sample, including shadow.
  float r=length(p);float muSun=dot(p/r,light);float horizonMu=-sqrt(max(0.,1.-1./(r*r)));
  float solarHalfAngle=.00465/r;float visibility=smoothstep(horizonMu-solarHalfAngle,horizonMu+solarHalfAngle,muSun);
  if(visibility<=0.)continue;
  float sunPath=max(0.,intersectSphere(p,light,1.01255).y);vec2 sunOptical=vec2(0.);
  for(int j=0;j<8;j++){float u=(float(j)+.5)/8.;vec3 s=p+light*(u*u*sunPath);float h=max(0.,(length(s)-1.)*R);sunOptical+=exp(-h/vec2(8.,1.2))*sunPath/8.*(2.*u)*R;}
  vec3 extinction=exp(-betaR*(optical.x+sunOptical.x)-betaM*(optical.y+sunOptical.y));scatter+=visibility*extinction*(local.x*betaR*phaseR+local.y*betaM*phaseM);
 }
 gl_FragColor=vec4(scatter*4.,1.);
 #include <tonemapping_fragment>
 #include <colorspace_fragment>
}`,
  });
  return {
    surface,
    clouds,
    atmosphere,
    setSun: (direction) => sun.value.set(direction[0], direction[1], direction[2]).normalize(),
    setRegionalMap: (texture, bounds) => {
      uniforms.regionalDayMap.value = texture || day;
      if (bounds) uniforms.regionalBounds.value.fromArray(bounds);
      if (!texture) uniforms.regionalOpacity.value = 0;
    },
    setRegionalOpacity: (opacity) => {
      uniforms.regionalOpacity.value = opacity;
    },
    setCloudTiles: (tiles) => {
      for (let i = 0; i < cloudTileCount; i++) {
        const tile = tiles[i];
        cloudUniforms.nativeCloudMaps.value[i] = tile?.texture || cloud;
        cloudUniforms.nativeCloudOpacity.value[i] = tile?.opacity || 0;
        if (tile) {
          cloudUniforms.nativeCloudBounds.value[i].fromArray(tile.bounds);
          cloudUniforms.nativeCloudFeather.value[i].fromArray(tile.featherEdges);
        }
      }
    },
    dispose: () => {
      surface.dispose();
      clouds.dispose();
      atmosphere.dispose();
    },
  };
}
