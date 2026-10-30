import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_ORBIT_CAMERA } from '../shared/orbit-camera';
import { cameraAtSceneScale, sceneCameraDistance, fitSceneScale } from '../src/features/layers/scene-camera';
import { cameraRotation, rotatePoint, projectPoint, projectPlane, pointOnProjectedPlane } from '../src/features/layers/projection';
import type { ScenePlane } from '../src/features/layers/types';

const size = { width: 1080, height: 2400 };
const frames = [0, -900].map(z => ({bounds: {left: 0, top: 0, right: 1080, bottom: 2400}, z}));
const center = {x: 540, y: 1200, z: -450};
const close = (a: number, b: number) => assert.ok(Math.abs(a-b) < 1e-7, `${a} != ${b}`);

test('60/75 degree side views retain exactly the same perspective through zoom', () => {
  for (const azimuth of [0, 60, 75, 105]) {
    const camera = {...DEFAULT_ORBIT_CAMERA, azimuth, elevation: 6};
    const distance = sceneCameraDistance(camera, size, frames, center);
    const projected = (scale: number, x: number, y: number, z: number) => projectPoint(x*scale, y*scale, z*scale,
      {x:center.x*scale,y:center.y*scale,z:center.z*scale}, cameraAtSceneScale(camera,distance,scale), cameraRotation(camera));
    for (const zoom of [.05, .5, 1, 2, 4]) for (const z of [0, -900]) for (const x of [0,1080]) for (const y of [0,2400]) {
      const actual = projected(zoom, x,y,z), original = projected(1,x,y,z);
      close(actual.x/zoom, original.x); close(actual.y/zoom, original.y);
    }
  }
});

test('fit respects all projected corners including scene depth at side angles', () => {
  for (const azimuth of [0,60,75,120]) for (const elevation of [-60,0,60]) {
    const camera = {...DEFAULT_ORBIT_CAMERA,azimuth,elevation};
    const distance = sceneCameraDistance(camera,size,frames,center), scale=fitSceneScale(frames,center,camera,distance,500,720);
    for (const f of frames) for (const x of [0,1080]) for (const y of [0,2400]) {
      const point=projectPoint(x,y,f.z,center,{...camera,distance},cameraRotation(camera));
      assert.ok(Math.abs(point.x-center.x)*scale <= 500*.43+1e-7);
      assert.ok(Math.abs(point.y-center.y)*scale <= 720*.43+1e-7);
    }
  }
});

test('capture pixel density and viewport size do not change perspective', () => {
  const camera=DEFAULT_ORBIT_CAMERA;
  const base=sceneCameraDistance(camera,size,frames,center);
  const doubled=sceneCameraDistance(camera,{width:2160,height:4800},frames.map(f=>({z:f.z*2,bounds:{left:0,top:0,right:2160,bottom:4800}})),{x:1080,y:2400,z:-900});
  close(doubled,base*2);
});

test('a very deep complete scene stays in front of the eye at every rotation', () => {
  const deep=[{bounds:frames[0].bounds,z:-245760},{bounds:frames[0].bounds,z:0}],pivot={...center,z:-122880};
  const distance=sceneCameraDistance(DEFAULT_ORBIT_CAMERA,size,deep,pivot);
  for(const azimuth of [0,60,75,180])for(const elevation of [-65,0,65])for(const f of deep) {
    const camera={...DEFAULT_ORBIT_CAMERA,distance,azimuth,elevation};
    const point=projectPoint(1080,2400,f.z,pivot,camera,cameraRotation(camera));
    assert.ok(distance>point.depth);assert.ok(Number.isFinite(point.x)&&Number.isFinite(point.y));
  }
});

test('perspective-correct picking returns the same source point at all zooms', () => {
  for (const azimuth of [60,75]) for (const scale of [.1,.5,1,2]) {
    const camera={...DEFAULT_ORBIT_CAMERA,azimuth},distance=sceneCameraDistance(camera,size,frames,center);
    const eye=cameraAtSceneScale(camera,distance,scale),pivot={x:center.x*scale,y:center.y*scale,z:center.z*scale};
    const plane={rect:{left:0,top:0,width:1080*scale,height:2400*scale},z:-900*scale} as ScenePlane;
    const projected=projectPlane(plane,pivot,eye,cameraRotation(eye));
    const point=projectPoint(1080*.31*scale,2400*.67*scale,plane.z,pivot,eye,cameraRotation(eye));
    const source=pointOnProjectedPlane({...projected,node:{} as never,painted:{plane,cornerDepths:projected.corners.map(c=>c.depth),camera:eye,pivot,visible:true,kind:'native'}},point)!;
    assert.ok(source);close(source.x,.31);close(source.y,.67);
  }
});

// Reference values captured from native SceneKit SCNNode.eulerAngles.
test('rotation matches SceneKit at combined pitch, yaw and roll', () => {
  const camera = {...DEFAULT_ORBIT_CAMERA, azimuth: -.4 * 180 / Math.PI, elevation: -.2 * 180 / Math.PI, roll: .3 * 180 / Math.PI};
  const result = rotatePoint(100, -200, 300, {x:0,y:0,z:0}, cameraRotation(camera));
  for (const [key, expected] of Object.entries({x:252.4699249, y:64.6919250, depth:268.4657898}))
    assert.ok(Math.abs(result[key as keyof typeof result] - expected) < 1e-4, `${key}: ${result[key as keyof typeof result]}`);
});

test('horizontal side rotation keeps equal-height planes on the same vertical baseline', () => {
  const rotation = cameraRotation({...DEFAULT_ORBIT_CAMERA, azimuth:90});
  for (const z of [-800,-400,0]) for (const x of [0,1080]) {
    close(rotatePoint(x,0,z,center,rotation).y,1200);
    close(rotatePoint(x,2400,z,center,rotation).y,-1200);
  }
});
