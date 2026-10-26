import {
  Data3DTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  RGFormat,
  UnsignedByteType,
} from 'three';

export const CLOUD_VOLUME_TOP_M = 10000;
// Enclose the analytic volume even between the geodetic mesh's vertices.
export const CLOUD_VOLUME_MESH_M = 12000;
export const CLOUD_NOISE_SIZE = 64;
let noiseData: Uint8Array | undefined;

export function cloudVolumeWeight(radius: number, enabled = true) {
  const t = Math.max(0, Math.min(1, (1.65 - radius) / 0.4));
  return enabled ? t * t * (3 - 2 * t) : 0;
}

function hash(index: number) {
  let value = Math.imul(index ^ 0x5bd1e995, 0x27d4eb2d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x85ebca6b);
  return ((value ^ (value >>> 13)) >>> 0) / 4294967296;
}

/** Original body/height noise; the NASA atlas supplies no cloud heights. */
export function createCloudNoise() {
  if (!noiseData) {
    const size = CLOUD_NOISE_SIZE;
    noiseData = new Uint8Array(size ** 3 * 2);
    const lattice = (x: number, y: number, z: number, n: number) =>
      ((z + n) % n) * n * n + ((y + n) % n) * n + ((x + n) % n);
    const valueNoise = (x: number, y: number, z: number, n: number) => {
      const ix = Math.floor(x),
        iy = Math.floor(y),
        iz = Math.floor(z);
      const fade = (v: number) => v * v * (3 - 2 * v);
      const fx = fade(x - ix),
        fy = fade(y - iy),
        fz = fade(z - iz);
      let value = 0;
      for (let k = 0; k < 2; k++)
        for (let j = 0; j < 2; j++)
          for (let i = 0; i < 2; i++)
            value +=
              hash(lattice(ix + i, iy + j, iz + k, n) + n ** 3) *
              (i ? fx : 1 - fx) *
              (j ? fy : 1 - fy) *
              (k ? fz : 1 - fz);
      return value;
    };
    const features = Float32Array.from({ length: 8 ** 3 * 3 }, (_, i) => hash(i + 113));
    for (let z = 0; z < size; z++)
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const px = (x + 0.5) / 8,
            py = (y + 0.5) / 8,
            pz = (z + 0.5) / 8;
          const ix = Math.floor(px),
            iy = Math.floor(py),
            iz = Math.floor(pz);
          let nearest = 3;
          for (let k = -1; k <= 1; k++)
            for (let j = -1; j <= 1; j++)
              for (let i = -1; i <= 1; i++) {
                const index = lattice(ix + i, iy + j, iz + k, 8) * 3;
                const dx = ix + i + features[index] - px;
                const dy = iy + j + features[index + 1] - py;
                const dz = iz + k + features[index + 2] - pz;
                nearest = Math.min(nearest, dx * dx + dy * dy + dz * dz);
              }
          const body =
            0.65 * valueNoise(px, py, pz, 8) + 0.35 * Math.max(0, 1 - Math.sqrt(nearest));
          const offset = ((z * size + y) * size + x) * 2;
          noiseData[offset] = Math.round(255 * body);
          noiseData[offset + 1] = Math.round(255 * valueNoise(px * 2, py * 2, pz * 2, 16));
        }
  }
  const texture = new Data3DTexture(
    noiseData,
    CLOUD_NOISE_SIZE,
    CLOUD_NOISE_SIZE,
    CLOUD_NOISE_SIZE,
  );
  texture.format = RGFormat;
  texture.type = UnsignedByteType;
  texture.colorSpace = NoColorSpace;
  texture.wrapS = texture.wrapT = texture.wrapR = RepeatWrapping;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = true;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

// Display-only 2–10 km layer: Beer–Lambert extinction, normalized to the old .94c alpha.
// Transfer convention: https://pbr-book.org/4ed/Volume_Scattering/Transmittance
// Beer–Lambert integration: PBRT 4e §11.2, https://pbr-book.org/4ed/Volume_Scattering/Transmittance
// Heights and density profiles below are illustrative; the NASA image supplies only coverage artwork.
export const cloudVolumeFragment = `
uniform sampler3D cloudNoise;
uniform float cloudVolumeMix;
uniform float cloudCameraNear;
uniform bool cloudResolved;
uniform sampler2D cloudVolumeColor;
uniform sampler2D cloudVolumeDepth;
uniform vec2 cloudVolumeTexel;
uniform vec2 cloudOutputSize;
uniform mat4 projectionMatrix;
const float cloudBottom=1.+2./6378.137;
const float cloudTop=1.+10./6378.137;
vec2 cloudUv(vec3 p){
 vec3 n=normalize(vec3(p.x,p.y/.9966471893,p.z));return vec2(atan(-n.z,n.x)/6.283185307+.5,asin(clamp(n.y,-1.,1.))/3.141592654+.5);
}
vec2 cloudUvDelta(vec2 delta){delta.x-=floor(delta.x+.5);return delta;}
vec4 cloudSegments(vec3 origin,vec3 ray){
 vec2 outer=atmosphereIntersection(origin,ray,cloudTop);
 float start=max(0.,outer.x),end=outer.y;
 vec2 ground=atmosphereIntersection(origin,ray,1.);
 if(ground.x>0.)end=min(end,ground.x);
 vec2 inner=atmosphereIntersection(origin,ray,cloudBottom);
 vec4 spans=vec4(start,end,0.,0.);
 if(inner.y>start&&inner.x<end){
  spans.y=min(end,inner.x);spans.z=max(start,inner.y);spans.w=end;
 }
 spans.y=max(spans.x,spans.y);spans.w=max(spans.z,spans.w);
 if(spans.y<=spans.x){spans.xy=spans.zw;spans.zw=vec2(0.);}
 return spans;
}
float cloudProfileIntegral(float u){float t=clamp(u,0.,1.);return t*t*(3.-2.*t);}
float cloudOpticalDepth(float coverage){return -log(max(.06,1.-.94*coverage));}
float cloudDensity(vec3 p,vec2 dx,vec2 dy,float lod,float verticalFootprintKm){
 float coverage=cloudCoverageGrad(cloudUv(p),dx,dy);
 if(coverage<.001)return 0.;
 vec3 km=p*earthAxes*earthRadiusKm;
 vec2 first=textureLod(cloudNoise,km/48.,lod).rg;
 vec3 rotated=vec3(.8*km.x+.6*km.z,.36*km.x+.8*km.y-.48*km.z,-.48*km.x+.6*km.y+.64*km.z);
 vec2 second=textureLod(cloudNoise,rotated/79.3+vec3(.17,.37,.61),lod).rg;
 float body=.65*first.r+.35*second.r;
 float strong=smoothstep(.3,.9,coverage);
 float thickness=mix(.6,7.5,strong)*(1.+.1*(body-.5));
 float center=mix(8.,6.,strong)+.2*strong*(first.g-second.g);
 float height=(length(p)-1.)*earthRadiusKm;
 float u=(height-center)/thickness+.5;
 float du=max(verticalFootprintKm/thickness,1e-4);
 float profile=(cloudProfileIntegral(u+.5*du)-cloudProfileIntegral(u-.5*du))/du;
 return cloudOpticalDepth(coverage)*profile/thickness;
}
float cloudSunTransmission(vec3 p,vec3 light,vec2 dx,vec2 dy,float lod){
 float distance=min(max(0.,atmosphereIntersection(p,light,cloudTop).y),18./earthRadiusKm);
 float stepSize=distance/2.,stepKm=stepSize*earthRadiusKm*length(light*earthAxes);float optical=0.;
 for(int j=0;j<2;j++){
  vec3 q=p+light*((float(j)+.5)*stepSize);
  optical+=cloudDensity(q,dx,dy,lod,stepKm*abs(dot(normalize(q),light)))*stepKm;
 }
 return exp(-optical);
}
vec4 cloudVolumeRay(vec3 origin,vec3 ray,vec4 spans,vec2 dx,vec2 dy,float pixelKm,out float depthDistance,out float hazeDistance){
 float firstLength=spans.y-spans.x,total=firstLength+spans.w-spans.z;
 float stepSize=total/12.;float stepKm=stepSize*earthRadiusKm*length(ray*earthAxes);
 vec3 entry=origin+ray*spans.x;
 vec2 marchUv=cloudUvDelta(cloudUv(entry+ray*stepSize)-cloudUv(entry));
 float filterScale=max(1.,length(marchUv)/max(max(length(dx),length(dy)),1e-7));
 dx*=filterScale;dy*=filterScale;
 float lod=clamp(log2(max(max(pixelKm,stepKm),.01)*64./48.),0.,6.);
 vec3 light=normalize(sun/earthAxes);float cosine=dot(ray,light),g=.55;
 float phase=.85+.15*(1.-g*g)/pow(1.+g*g-2.*g*cosine,1.5);
 vec3 radiance=vec3(0.);float transmission=1.,weightedDistance=0.;
 depthDistance=spans.x;bool occupied=false;
 for(int i=0;i<12;i++){
  float along=(float(i)+.5)*stepSize;
  float distance=along<firstLength?spans.x+along:spans.z+along-firstLength;
  vec3 p=origin+ray*distance;float density=cloudDensity(p,dx,dy,lod,stepKm*abs(dot(normalize(p),ray)));
  if(density<=0.)continue;
  if(!occupied){depthDistance=max(along<firstLength?spans.x:spans.z,distance-.5*stepSize);occupied=true;}
  float alpha=1.-exp(-density*stepKm);
  float visibility=cloudSunlight(dot(normalize(p),light),length(p));
  float sunlight=cloudSunTransmission(p,light,dx,dy,lod);
  vec3 lighting=vec3(.025,.035,.05)+vec3(1.,.985,.96)*visibility*(.12+1.35*sunlight)*phase;
  float weight=transmission*alpha;
  radiance+=weight*lighting;weightedDistance+=weight*distance;
  transmission*=1.-alpha;
  if(transmission<.015)break;
 }
 float alpha=1.-transmission;hazeDistance=weightedDistance/max(alpha,1e-6);
 return vec4(radiance,alpha);
}
float cloudDepthAt(vec3 origin,vec3 ray,float distance){
 float axialPerT=-(viewMatrix*vec4(ray*earthAxes,0.)).z;
 float tNear=cloudCameraNear/max(axialPerT,1e-6);
 vec3 depthPoint=(origin+ray*max(distance,tNear*1.01))*earthAxes;
 vec4 projected=projectionMatrix*viewMatrix*vec4(depthPoint,1.);
 return clamp(.5*projected.z/projected.w+.5,0.,1.);
}
vec4 resolvedCloudVolume(vec2 uv,out float depth){
 vec4 color=texture2D(cloudVolumeColor,uv);
 vec2 base=(floor(uv/cloudVolumeTexel-.5)+.5)*cloudVolumeTexel;
 depth=min(min(texture2D(cloudVolumeDepth,base).r,texture2D(cloudVolumeDepth,base+vec2(cloudVolumeTexel.x,0.)).r),
           min(texture2D(cloudVolumeDepth,base+vec2(0.,cloudVolumeTexel.y)).r,texture2D(cloudVolumeDepth,base+cloudVolumeTexel).r));
 return depth<1.?color:vec4(0.);
}
void outputCloud(vec4 result,float depth){
 if(result.a<.001)discard;
 gl_FragDepth=depth;
 gl_FragColor=vec4(result.rgb/result.a,result.a);
 #include <tonemapping_fragment>
 #include <colorspace_fragment>
}
void main(){
 vec3 origin=cameraPosition/earthAxes,ray=normalize((vPosition-cameraPosition)/earthAxes);
 if(cloudResolved&&cloudVolumeMix>=1.){
  vec2 outer=atmosphereIntersection(origin,ray,cloudTop);
  if(outer.y<=max(0.,outer.x))discard;
  float depth;vec4 result=resolvedCloudVolume(gl_FragCoord.xy/cloudOutputSize,depth);
  outputCloud(result,depth);return;
 }
 vec4 spans=cloudSegments(origin,ray);
 float occupiedLength=spans.y-spans.x+spans.w-spans.z;
 vec3 entry=origin+ray*max(spans.x,min(.5*occupiedLength,2./earthRadiusKm));
 vec2 uv=cloudUv(entry),dx=cloudUvDelta(dFdx(uv)),dy=cloudUvDelta(dFdy(uv));
 float pixelKm=max(length(dFdx(entry)*earthAxes),length(dFdy(entry)*earthAxes))*earthRadiusKm;
 vec2 shellHit=atmosphereIntersection(origin,ray,1.+8./earthRadiusKm);
 float shellDistance=shellHit.x>0.?shellHit.x:shellHit.y;
 vec3 shellPoint=origin+ray*max(0.,shellDistance);
 vec2 shellUv=cloudUv(shellPoint);
 vec2 shellDx=cloudUvDelta(dFdx(shellUv)),shellDy=cloudUvDelta(dFdy(shellUv));
 if(spans.y-spans.x+spans.w-spans.z<=0.)discard;
 vec4 shell=vec4(0.),volume=vec4(0.);float shellDepth=1.,volumeDepth=1.;
 if(cloudResolved&&cloudVolumeMix<1.){
  vec2 ground=atmosphereIntersection(origin,ray,1.);
  if(shellDistance>0.&&(ground.x<=0.||shellDistance<ground.x)){
   float alpha=cloudCoverageGrad(shellUv,shellDx,shellDy)*.94;
   if(alpha>=.001){
    float light=cloudSunlight(dot(normalize(shellPoint),normalize(sun/earthAxes)),length(shellPoint));
    vec3 color=throughAtmosphere(shellPoint*earthAxes,vec3(.99,.99,1.)*(.008+light*1.4));
    shell=vec4(color*alpha,alpha);shellDepth=cloudDepthAt(origin,ray,shellDistance);
   }
  }
 }
 if(cloudVolumeMix>0.){
  if(cloudResolved){volume=resolvedCloudVolume(gl_FragCoord.xy/cloudOutputSize,volumeDepth);}
  else{
   float depthDistance,hazeDistance;
   volume=cloudVolumeRay(origin,ray,spans,dx,dy,pixelKm,depthDistance,hazeDistance);
   if(volume.a>=.001){
    vec3 hazePoint=(origin+ray*hazeDistance)*earthAxes;
    volume.rgb=throughAtmosphere(hazePoint,volume.rgb/volume.a)*volume.a;
    volumeDepth=cloudDepthAt(origin,ray,depthDistance);
   }
  }
 }
 vec4 result=volume;float depth=volumeDepth;
 if(cloudResolved){
  result=mix(shell,volume,cloudVolumeMix);
  float volumeWeight=volume.a*cloudVolumeMix/max(result.a,1e-6);
  depth=mix(shellDepth,volumeDepth,volumeWeight);
 }
 outputCloud(result,depth);
}
`;
