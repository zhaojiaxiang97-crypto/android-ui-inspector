import {createRef} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {makeNode} from './fixtures';
import {Layer3DPreview} from '../src/features/layers/Layer3DPreview';
import {DEFAULT_ORBIT_CAMERA} from '../shared/orbit-camera';
import {DEFAULT_LAYER_APPEARANCE} from '../src/features/layers/appearance';
import type {LayerSceneHandle} from '../src/features/layers/types';

const tick=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
const assert=(ok:unknown,message:string)=>{if(!ok)throw new Error(`Scene camera: ${message}`);};

export async function verifySceneCamera() {
  const host=document.createElement('div');Object.assign(host.style,{position:'relative',width:'900px',height:'900px'});document.body.append(host);
  const mounted=createRoot(host),scene=createRef<LayerSceneHandle>(),bitmap=document.createElement('canvas');bitmap.width=bitmap.height=4;
  const context=bitmap.getContext('2d')!;
  const image=(color:string)=>{context.fillStyle=color;context.fillRect(0,0,4,4);return bitmap.toDataURL();};
  const root={...makeNode('camera-root'),bounds:{left:0,top:0,right:300,bottom:600,raw:'fixture'},layerImageEmpty:true};
  const back={...makeNode('camera-back'),bounds:{...root.bounds},layerImageDataUrl:image('blue'),layerImageSize:{width:4,height:4}};
  const front={...makeNode('camera-front'),bounds:{left:60,top:100,right:240,bottom:500,raw:'fixture'},layerImageDataUrl:image('red'),layerImageSize:{width:4,height:4}};
  root.children=[back,front];const original=JSON.stringify(root),expanded=new Set([root.id]);
  let bytes:string|undefined;
  try {
    for(const azimuth of [60,75]) {
      let baseline:{x:number;y:number}|undefined;
      for(const scale of [.45,.7,1]) {
        const camera={...DEFAULT_ORBIT_CAMERA,azimuth,elevation:0,roll:0};
        flushSync(()=>mounted.render(<Layer3DPreview ref={scene} src={back.layerImageDataUrl} root={root} selectedNode={null} expandedNodeIds={expanded} size={{width:300,height:600}} renderScale={scale} origin={{left:450-150*scale,top:450-300*scale}} camera={camera} appearance={{...DEFAULT_LAYER_APPEARANCE,showOutlines:false}} initialFitNeeded={false} onSelect={()=>{}}/>));
        const canvas=host.querySelector<HTMLCanvasElement>('canvas')!,deadline=performance.now()+4000;
        while(canvas.dataset.layerTextureCount!=='2'||canvas.dataset.layerTexturePendingCount!=='0') {assert(performance.now()<deadline,'textures did not settle');await tick();}
        scene.current!.paintCamera(camera);
        const gl=canvas.getContext('webgl')!,program=gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
        const eye=gl.getUniform(program,gl.getUniformLocation(program,'u_distance')!) as number;
        // Independent formula from fixed 400-unit screen coordinates; do not
        // import the production projection or fitting helpers for this oracle.
        const distance=camera.distance*600/400*scale;
        assert(Math.abs(eye-distance)<.001,'GPU camera did not scale with zoom');
        const data=host.querySelector<HTMLElement>('.layer-scene')!.dataset;
        const pivotZ=Number(data.layerPivotZ),z=Number(host.querySelector<HTMLElement>(`[data-layer-node-id="${front.id}"]`)!.dataset.layerZ)*scale;
        const yaw=-azimuth*Math.PI/180,dx=20*scale,dy=30*scale,dz=z-pivotZ;
        const rx=Math.cos(yaw)*dx+Math.sin(yaw)*dz,depth=-Math.sin(yaw)*dx+Math.cos(yaw)*dz;
        const perspective=distance/(distance-depth),point={x:450+rx*perspective,y:450-dy*perspective};
        const normalized={x:(point.x-450)/scale,y:(point.y-450)/scale};
        if(baseline)assert(Math.abs(normalized.x-baseline.x)<.03&&Math.abs(normalized.y-baseline.y)<.03,'zoom changed perspective');
        baseline=normalized;
        const rect=canvas.getBoundingClientRect();assert(scene.current!.pick(rect.left+point.x,rect.top+point.y)?.id===front.id,'source point no longer selects the painted front layer');
        const pixel=new Uint8Array(4);gl.readPixels(Math.floor(point.x*canvas.width/rect.width),Math.floor(canvas.height-point.y*canvas.height/rect.height),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
        assert(pixel[0]>240&&pixel[1]<10&&pixel[2]<10,'GPU pixels disagree with independent projected point');
        if(bytes)assert(canvas.dataset.layerTextureBytes===bytes,'zoom changed image allocations');
        bytes=canvas.dataset.layerTextureBytes;
      }
    }
    assert(JSON.stringify(root)===original,'projection changed captured data');
    return ['camera: 60°/75° at three zoom levels preserve perspective, GPU pixels/picking, image allocations and captured bounds'];
  }finally{flushSync(()=>mounted.unmount());host.remove();}
}
