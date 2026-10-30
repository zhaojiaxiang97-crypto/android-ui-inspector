import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { buildLayerOverview } from "../shared/layer-layout";
import type { UiNode } from "../shared/types";

const size = { width: 200, height: 200 };
const node = (id: string, left = 0, right = 200): UiNode => ({ ...makeNode(id), text: id,
  bounds: { left, top: 0, right, bottom: 200, raw: "fixture" }, children: [] });
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < .011, `${actual} != ${expected}`);
const span = (layout: ReturnType<typeof buildLayerOverview>) => {
  const all = [...(layout.parent ? [layout.parent] : []), ...layout.records];
  return Math.max(...all.map(r => r.z)) - Math.min(...all.map(r => r.z));
};

test("a long empty hierarchy retains every node without accumulating empty space", () => {
  const root = node("root"), front = node("front"), back = node("back"), expandedIds = new Set([root.id]);
  root.children = [back]; let parent = root;
  for (let i = 0; i < 80; i++) {
    const wrapper = node(`wrapper-${i}`, i % 4, 200 - i % 5); wrapper.layerImageEmpty = true;
    parent.children.push(wrapper); parent = wrapper; expandedIds.add(wrapper.id);
  }
  parent.children = [front]; const before = JSON.stringify(root);
  const compact = buildLayerOverview(root, front, size, { expandedIds, layerGap: 64 });
  close(span(compact), 128);
  assert.equal(compact.records.length, 82);
  assert.equal(compact.records.filter(r => r.isCompact).length, 80);
  assert.ok(compact.records.every(r => r.hitTestable));
  const full = buildLayerOverview(root, front, size, { expandedIds, layerGap: 64, compactStructure: false });
  close(span(full), 82 * 64);
  assert.deepEqual(full.records.map(r => r.id), compact.records.map(r => r.id));
  assert.deepEqual(buildLayerOverview(root, parent, size, { expandedIds, layerGap: 64 }).records.map(r => r.z), compact.records.map(r => r.z));
  assert.equal(JSON.stringify(root), before);
});

test("wide empty wrappers cannot bridge unrelated content into a deeper stack", () => {
  const root = node("root"), left = node("left", 0, 60), right = node("right", 140, 200), wrapper = node("wrapper");
  wrapper.attributes = { "skip-draw": "true" }; wrapper.children = [right]; root.children = [left, wrapper];
  const { records } = buildLayerOverview(root, null, size);
  const depths = new Map(records.map(r => [r.id, r.z]));
  close(depths.get(left.id)!, depths.get(right.id)!);
  assert.equal(records.find(r => r.id === wrapper.id)?.isCompact, true);
});

test("hidden images close their slot before packing and do not consume the render cap", () => {
  const root = node("root"), back = node("back"), hidden = node("hidden"), child = node("child"), front = node("front");
  hidden.children = [child]; root.children = [back, hidden, front];
  const normal = buildLayerOverview(root, null, size), concealed = buildLayerOverview(root, null, size, { hiddenIds: new Set([hidden.id]) });
  close(span(normal) - span(concealed), 64);
  assert.deepEqual(concealed.records.map(r => r.id), [back.id, child.id, front.id]);
  const capped = buildLayerOverview(root, null, size, { hiddenIds: new Set([hidden.id, back.id]), maxLayers: 2 });
  assert.deepEqual(capped.records.map(r => r.id), [child.id, front.id]);
  assert.equal(capped.truncated, false);
  const hiddenRoot = buildLayerOverview(root, null, size, { hiddenIds: new Set([root.id]) });
  assert.equal(hiddenRoot.parent, null); assert.equal(hiddenRoot.records.length, normal.records.length);
});

test("diagnostic invisible boundaries do not increase visible content spacing", () => {
  const root = node("root"), back = node("back"), invisible = node("invisible"), child = node("invisible-child"), front = node("front");
  invisible.visibleToUser = false; invisible.children = [child]; root.children = [back, invisible, front];
  const normal = buildLayerOverview(root, null, size), shown = buildLayerOverview(root, null, size, { showInvisible: true });
  close(span(normal), span(shown));
  assert.deepEqual(shown.records.filter(r => r.isCompact).map(r => r.id), [invisible.id, child.id]);
  const complete = buildLayerOverview(root, null, size, { showInvisible: true, compactStructure: false });
  close(span(complete), 256);
});

test("unknown, failed, semi-transparent and folded content keep their own depth slots", () => {
  const root = node("root"), empty = node("empty"); empty.layerImageEmpty = true;
  const failed = node("failed"); failed.layerImageStatus = "failed"; failed.layerImageEmpty = true;
  const ambiguous = node("ambiguous"); ambiguous.layerImageStatus = "ambiguous"; ambiguous.attributes = { "skip-draw": "true" };
  const semi = node("semi"); semi.layerImageDataUrl = "saved-image"; semi.layerImageEmpty = false; semi.attributes = { alpha: "0.25" };
  const folded = node("folded"); folded.layerImageEmpty = true; folded.children = [node("visible-child")];
  root.children = [empty, failed, ambiguous, semi, folded];
  const result = buildLayerOverview(root, null, size, { expandedIds: new Set([root.id]) });
  assert.deepEqual(result.records.map(r => r.isCompact), [true, false, false, false, false]);
  close(span(result), 256);
  for (let i = 2; i < result.records.length; i++) close(result.records[i].z - result.records[i - 1].z, 64);
});

test("all-empty scenes stay compact at the rendering cap and have stable ordered boundaries", () => {
  const root = node("root"); root.children = Array.from({ length: 1024 }, (_, i) => ({ ...node(String(i)), layerImageEmpty: true }));
  const compact = buildLayerOverview(root, null, size, { maxLayers: 1024 });
  assert.ok(span(compact) <= .01);
  assert.ok(compact.records.every((r, i) => i === 0 || r.z > compact.records[i - 1].z));
  assert.equal(compact.records.length, 1024);
});

test("only overlapping siblings advance across empty wrappers", () => {
  const root = node("root"), background = node("background", 0, 80), group = node("group");
  const left = node("left", 0, 70), right = node("right", 120, 190);
  const wrapLeft = { ...node("wrap-left"), layerImageEmpty: true, children: [left] };
  const wrapRight = { ...node("wrap-right"), layerImageEmpty: true, children: [right] };
  group.layerImageEmpty = true; group.children = [wrapLeft, wrapRight]; root.children = [background, group];
  const original = JSON.stringify(root), hiddenIds = new Set([root.id, group.id, wrapLeft.id, wrapRight.id]);
  const layout = buildLayerOverview(root, null, size, { hiddenIds });
  const depths = new Map(layout.records.map(record => [record.id, record.z]));
  assert.deepEqual(layout.records.map(record => record.id), [background.id, left.id, right.id]);
  close(depths.get(left.id)! - depths.get(right.id)!, 64);
  close(depths.get(left.id)! - depths.get(background.id)!, 64);
  const complete = buildLayerOverview(root, null, size, { hiddenIds, compactStructure: false });
  assert.deepEqual(complete.records.map(r => r.z), layout.records.map(r => r.z), "hidden containers do not change overlap packing in either mode");
  assert.deepEqual(buildLayerOverview(root, right, size, { hiddenIds }).records.map(record => record.z), layout.records.map(record => record.z));
  assert.equal(JSON.stringify(root), original);
});

test("overlays advance only above the content they overlap", () => {
  const root = node("root"), background = node("background", 0, 80), group = node("group"), other = node("other");
  const left = node("left", 0, 70), right = node("right", 100, 150), overlay = node("overlay", 105, 145), unrelated = node("unrelated", 160, 200);
  group.layerImageEmpty = other.layerImageEmpty = true; group.children = [left, right]; other.children = [unrelated];
  root.children = [background, group, overlay, other];
  const result = buildLayerOverview(root, null, size), depths = new Map(result.records.map(record => [record.id, record.z]));
  close(depths.get(left.id)! - depths.get(right.id)!, 64);
  close(depths.get(overlay.id)! - depths.get(right.id)!, 64);
  assert(depths.get(unrelated.id)! < depths.get(left.id)!);
});

test("a decoration advances above its backing without moving a disjoint sibling", () => {
  const root = node("root"), background = node("background", 0, 80), group = node("group");
  const left = node("left", 0, 70), right = node("right", 120, 190), badge = node("badge", 20, 40);
  group.layerImageEmpty = true; group.children = [left, right, badge]; root.children = [background, group];
  const depths = new Map(buildLayerOverview(root, null, size).records.map(record => [record.id, record.z]));
  close(depths.get(left.id)! - depths.get(right.id)!, 64);
  close(depths.get(badge.id)! - depths.get(left.id)!, 64);
});

test("a descendant crossing between disjoint siblings keeps its original occlusion chain", () => {
  const root = node("root"), group = node("group"), left = node("left", 0, 70), right = node("right", 120, 190), bridge = node("bridge");
  group.layerImageEmpty = true; group.children = [left, right]; left.children = [bridge]; root.children = [group];
  const hiddenIds = new Set([root.id, group.id]);
  const regular = buildLayerOverview(root, null, size, { hiddenIds });
  const complete = buildLayerOverview(root, null, size, { hiddenIds, compactStructure: false });
  assert.deepEqual(regular.records.map(record => record.z), complete.records.map(record => record.z));
  close(regular.records[1].z - regular.records[0].z, 64);
  close(regular.records[2].z - regular.records[1].z, 64);
});

test("overlap packing uses the lowest valid integer depth in dense nested scenes", () => {
  let seed = 713;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let scene = 0; scene < 12; scene++) {
    const root = node("root"); root.layerImageEmpty = true;
    for (let groupIndex = 0; groupIndex < 12; groupIndex++) {
      const group = node(`group-${groupIndex}`); group.layerImageEmpty = true;
      for (let item = 0; item < 6; item++) {
        const left = Math.floor(random() * 180), top = Math.floor(random() * 180);
        const content = node(`${group.id}-${item}`, left, Math.min(200, left + 10 + Math.floor(random() * 50)));
        content.bounds!.top = top; content.bounds!.bottom = Math.min(200, top + 10 + Math.floor(random() * 50));
        group.children.push(content);
      }
      root.children.push(group);
    }
    const records = buildLayerOverview(root, null, size).records.filter(record => !record.isCompact);
    for (let index = 0; index < records.length; index++) {
      assert(Number.isFinite(records[index].z));
      let expected = 0;
      for (let previous = 0; previous < index; previous++) {
        const a = records[previous].renderBounds, b = records[index].renderBounds;
        if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
          expected = Math.max(expected, records[previous].z - records[0].z + 64);
          assert(records[index].z - records[previous].z >= 64 - .001, `scene ${scene}: overlap order was changed`);
        }
      }
      close(records[index].z - records[0].z, expected);
    }
  }
});

const painted = (id: string, left = 0, right = 200): UiNode => ({ ...node(id, left, right), layerImageDataUrl: 'fixture-image', layerImageEmpty: false, layerImageStatus: 'captured' });

test('branching empty wrappers do not force unrelated content onto a common baseline', () => {
  const root = node('root'), panel = node('panel'), backing = painted('backing',0,70);
  panel.layerImageEmpty=true;panel.className='androidx.cardview.widget.CardView';
  const left = painted('left',0,60), right = painted('right',120,190), extra = painted('extra',80,100);
  const wrapper = {...node('wrapper'),layerImageEmpty:true,children:[left,extra]};
  panel.children=[wrapper,right];root.children=[backing,panel];
  const before=JSON.stringify(root), records=buildLayerOverview(root,null,size).records;
  const z=new Map(records.map(r=>[r.id,r.z]));
  close(z.get('left')!-z.get('backing')!,64);
  close(z.get('left')!-z.get('right')!,64);close(z.get('extra')!,z.get('right')!);
  assert.equal(JSON.stringify(root),before);
});

test('nested backgrounds and separate panels use the same whole depth levels', () => {
  const root=node('root'), panel=painted('panel'), sameFrame=painted('same-frame'), text=painted('text',10,40), overlay=painted('overlay',80,180);
  sameFrame.children=[text];panel.children=[sameFrame];overlay.children=[painted('label',90,110)];root.children=[panel,overlay];
  const records=buildLayerOverview(root,null,size).records,z=new Map(records.map(r=>[r.id,r.z]));
  close(z.get('same-frame')!-z.get('panel')!,64);
  close(z.get('text')!-z.get('same-frame')!,64);
  assert(z.get('overlay')!-z.get('same-frame')!>=64);
  const full=buildLayerOverview(root,null,size,{compactStructure:false}).records;
  close(full[1].z-full[0].z,64);
});

test('even a one-pixel overlap keeps its own level instead of creating a fractional gap', () => {
  const root=node('root'), list=node('list');list.layerImageEmpty=true;list.className='androidx.recyclerview.widget.RecyclerView';
  list.children=[painted('a',0,101),painted('b',100,201),painted('c',200,301)].map(item=>({...item,children:[painted(`${item.id}-child`,item.bounds!.left,item.bounds!.right)]}));root.children=[list];
  const options={expandedIds:new Set(['root','list']),layerGap:80};
  const records=buildLayerOverview(root,null,{width:301,height:200},options).records.filter(r=>r.isCollapsed);
  close(records[1].z-records[0].z,80);close(records[2].z-records[1].z,80);
  const full=buildLayerOverview(root,null,{width:301,height:200},{...options,compactStructure:false}).records.filter(r=>r.isCollapsed);
  close(full[2].z-full[0].z,160);
});

test('a narrow painted divider uses the same depth interval as other content', () => {
  const root=node('root'),panel=painted('panel'),divider=painted('divider',20,21),overlap=painted('overlap',10,100);
  panel.children=[divider,overlap];root.children=[panel];
  const records=buildLayerOverview(root,null,size).records;
  close(records[1].z-records[0].z,64);close(records[2].z-records[1].z,64);
});

test('clipped equal rectangles do not merge distinct offscreen panel components', () => {
  const root=node('root'),panel=painted('panel',-100,300),child=painted('child',-50,250);
  child.children=[painted('content')];panel.children=[child];root.children=[panel];
  const records=buildLayerOverview(root,null,size).records;
  close(records[1].z-records[0].z,64);
});

test('uniform overlap levels preserve every overlapping paint order', () => {
  let seed=914;
  const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
  for(let scene=0;scene<8;scene++) {
    const root=node('root');root.layerImageEmpty=true;
    for(let group=0;group<8;group++) {
      const panel=painted(`panel-${group}`);panel.className=group%2?'androidx.cardview.widget.CardView':'android.widget.FrameLayout';
      for(let i=0;i<6;i++) {
        const left=Math.floor(random()*170),top=Math.floor(random()*170),child=painted(`${group}-${i}`,left,Math.min(200,left+15+Math.floor(random()*70)));
        child.bounds!.top=top;child.bounds!.bottom=Math.min(200,top+20+Math.floor(random()*60));panel.children.push(child);
      }
      root.children.push(panel);
    }
    const before=JSON.stringify(root),records=buildLayerOverview(root,null,size).records.filter(r=>!r.isCompact);
    for(let i=0;i<records.length;i++)for(let j=0;j<i;j++) {
      const a=records[j].renderBounds,b=records[i].renderBounds;
      if(a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top)
        assert(records[i].z-records[j].z>=64-.001,`scene ${scene}: ${records[j].id} crossed ${records[i].id}`);
    }
    assert(records.every(record => Math.abs(record.z / 64 - Math.round(record.z / 64)) < 1e-8), 'painted layers left the uniform depth grid');
    assert.equal(JSON.stringify(root),before);
  }
});

test('the gap scales integer levels uniformly without moving content between levels', () => {
  const root = node('root'), panel = painted('panel'), nested = painted('nested');
  nested.children = [painted('left', 0, 60), painted('right', 100, 160)];
  panel.children = [nested];
  root.children = [panel, painted('overlay', 150, 200)];
  const before = JSON.stringify(root);
  const reference = buildLayerOverview(root, null, size, { layerGap: 64 }).records;
  for (const gap of [24, 80, 128, 208, 240]) {
    const records = buildLayerOverview(root, nested, size, { layerGap: gap }).records;
    assert.deepEqual(records.map(record => record.id), reference.map(record => record.id));
    records.forEach((record, index) => {
      close(record.z / gap, reference[index].z / 64);
      assert.equal(record.z / gap, Math.round(record.z / gap));
    });
  }
  assert.equal(JSON.stringify(root), before);
});
