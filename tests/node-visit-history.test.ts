import { test } from "node:test";
import assert from "node:assert/strict";
import { makeNode } from "../benchmarks/fixtures";
import type { UiNode } from "../shared/types";
import { createNodeVisitHistory, MAX_NODE_VISITS, reconcileNodeVisits, rememberNodeReading, stepNodeVisit, visitNode } from "../src/features/inspection/node-visit-history";

const node = (id: string, ref?: string): UiNode => ({ ...makeNode(id), className: "android.view.View", attributes: ref ? { "view-ref": ref } : {} });

test("node visits deduplicate the current selection, truncate forward visits and remain bounded", () => {
  const root = node("0"); root.children = Array.from({ length: 80 }, (_, i) => node(`0/${i}`));
  let history = createNodeVisitHistory(root, 1, root.children[0]);
  assert.equal(visitNode(history, root.children[0]), history);
  history = visitNode(visitNode(history, root.children[1]), root.children[2]);
  history = stepNodeVisit(history, -1);
  assert.equal(history.visits[history.cursor].node, root.children[1]);
  assert.equal(visitNode(history, root.children[1]), history);
  history = visitNode(history, root.children[3]);
  assert.deepEqual(history.visits.map(entry => entry.node), [root.children[0], root.children[1], root.children[3]]);
  assert.equal(stepNodeVisit(history, 1), history);
  for (const target of root.children) history = visitNode(history, target);
  assert.equal(history.visits.length, MAX_NODE_VISITS);
  assert.equal(history.visits[0].node, root.children[30]);
});

test("reading positions belong to visits and do not alter nodes or inherit from a different control", () => {
  const root = node("0"), a = node("a"), b = node("b"); root.children = [a, b];
  const source = JSON.stringify(root), initial = createNodeVisitHistory(root, 4, a);
  const saved = rememberNodeReading(initial, { tree: { top: 120, left: 35, scope: null }, inspector: { top: 320, left: 0, search: "颜色" } });
  assert.deepEqual(initial.visits[0].positions, {});
  let history = visitNode(saved, b);
  assert.deepEqual(history.visits[1].positions, {});
  history = stepNodeVisit(history, -1);
  assert.deepEqual(history.visits[history.cursor].positions, saved.visits[0].positions);
  assert.equal(JSON.stringify(root), source);
  const malformed = rememberNodeReading(history, { tree: { top: NaN, left: Infinity } });
  assert.deepEqual(malformed.visits[0].positions, saved.visits[0].positions);
});

test("a new tree session clears visits even when it reuses the same root object", () => {
  const root = node("0"), child = node("0/0"); root.children = [child];
  const history = visitNode(createNodeVisitHistory(root, 1, root), child);
  const next = reconcileNodeVisits(history, root, 2, child);
  assert.deepEqual(next.visits.map(entry => entry.node), [child]);
  assert.equal(next.cursor, 0); assert.equal(stepNodeVisit(next, -1), next);
  assert.equal(reconcileNodeVisits(history, null, 1, null).visits.length, 0);
});

test("refresh follows unique view refs and class identity through reordering, preserving per-visit reading", () => {
  const root = node("0", "Root@1"), a = node("0/0", "View@a"), b = node("0/1", "View@b"); root.children = [a, b];
  let history = visitNode(createNodeVisitHistory(root, 1, root), a);
  history = visitNode(rememberNodeReading(history, { inspector: { top: 211, left: 0 } }), b);
  const nextRoot = structuredClone(root), nextA = nextRoot.children[0], nextB = nextRoot.children[1];
  nextA.id = "0/1"; nextB.id = "0/0"; nextRoot.children = [nextB, nextA];
  const next = reconcileNodeVisits(history, nextRoot, 1, nextB);
  assert.deepEqual(next.visits.map(entry => entry.node), [nextRoot, nextA, nextB]);
  assert.equal(stepNodeVisit(next, -1).visits[1].positions.inspector?.top, 211);
});

test("refresh drops duplicate refs, changed types, and same-ID replacement objects without refs", () => {
  const root = node("0", "root"), noRef = node("0/0"), stable = node("0/1"), duplicated = node("0/2", "duplicate"), typed = node("0/3", "typed"), last = node("0/4", "last");
  root.children = [noRef, stable, duplicated, typed, last];
  let history = createNodeVisitHistory(root, 1, noRef);
  for (const target of [stable, duplicated, typed, last]) history = visitNode(history, target);
  const nextRoot = structuredClone(root);
  nextRoot.children[1] = stable;
  nextRoot.children.push(node("0/5", "duplicate"));
  nextRoot.children[3].className = "android.widget.TextView";
  const next = reconcileNodeVisits(history, nextRoot, 1, nextRoot.children[4]);
  assert.deepEqual(next.visits.map(entry => entry.node), [stable, nextRoot.children[4]]);
  // A duplicated source ref must not become valid merely because one copy disappeared.
  root.children.push(node("0/5", "duplicate"));
  const onlyOne = { ...root, children: root.children.slice(0, 5).map(value => ({ ...value })) };
  assert.ok(!reconcileNodeVisits(history, onlyOne, 1, onlyOne.children[4]).visits.some(entry => entry.node.attributes?.["view-ref"] === "duplicate"));
});

test("automatic refresh fallback keeps safely identified forward visits", () => {
  const root = node("root", "Root@1"), a = node("a", "View@a"), b = node("b", "View@b"), c = node("c", "View@c");
  root.children = [a, b, c];
  const history = stepNodeVisit(visitNode(visitNode(createNodeVisitHistory(root, 1, a), b), c), -1);
  const nextRoot = structuredClone(root); nextRoot.children.splice(1, 1);
  const next = reconcileNodeVisits(history, nextRoot, 1, nextRoot);
  assert.deepEqual(next.visits.map(entry => entry.node), [nextRoot.children[0], nextRoot, nextRoot.children[1]]);
  assert.equal(next.visits[next.cursor].node, nextRoot);
  const forward = stepNodeVisit(next, 1);
  assert.equal(forward.visits[forward.cursor].node, nextRoot.children[1]);
  // A following user selection still starts a new branch as usual.
  assert.deepEqual(visitNode(next, nextRoot.children[0]).visits.map(entry => entry.node), [nextRoot.children[0], nextRoot, nextRoot.children[0]]);
});
