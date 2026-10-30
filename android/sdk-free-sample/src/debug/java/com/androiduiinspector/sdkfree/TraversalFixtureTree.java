package com.androiduiinspector.sdkfree;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Fixed debug data shared by ordinary Views and AccessibilityNodeProvider. */
final class TraversalFixtureTree {
    static final class Node {
        final int id;
        final Node parent;
        final List<Node> children = new ArrayList<>();
        Node(int id, Node parent) { this.id = id; this.parent = parent; }
        int depth() { int result = 0; for (Node node = parent; node != null; node = node.parent) result++; return result; }
    }
    final String shape;
    final boolean virtual;
    final List<Node> nodes;
    private TraversalFixtureTree(String shape, boolean virtual, List<Node> nodes) {
        this.shape = shape; this.virtual = virtual; this.nodes = Collections.unmodifiableList(nodes);
    }
    static TraversalFixtureTree create(String shape) {
        boolean virtual = shape.equals("virtual80") || shape.equals("virtual300");
        int total, depth;
        if (shape.equals("deep100")) { total = 100; depth = 15; }
        else if (shape.equals("deep300") || shape.equals("virtual300")) { total = 300; depth = 23; }
        else if (shape.equals("deep500")) { total = 500; depth = 28; }
        else if (shape.equals("deep530")) { total = 530; depth = 29; }
        else if (shape.equals("deep750")) { total = 750; depth = 31; }
        else if (shape.equals("deep1000")) { total = 1000; depth = 34; }
        else if (shape.equals("real-wide80") || shape.equals("virtual80")) { total = 81; depth = 1; }
        else throw new IllegalArgumentException("Unknown fixed traversal shape");
        List<Node> nodes = new ArrayList<>(); Node root = add(nodes, null);
        if (depth == 1) { for (int i = 0; i < 80; i++) add(nodes, root); }
        else {
            List<Node> spine = new ArrayList<>(); spine.add(root);
            for (int i = 0; i < depth; i++) spine.add(add(nodes, spine.get(spine.size() - 1)));
            int branch = 0;
            while (nodes.size() < total) {
                Node parent = spine.get(branch++ % (spine.size() - 2));
                Node group = add(nodes, parent);
                for (int i = 0; i < 15 && nodes.size() < total; i++) add(nodes, group);
            }
        }
        return new TraversalFixtureTree(shape, virtual, nodes);
    }
    private static Node add(List<Node> nodes, Node parent) {
        Node node = new Node(nodes.size() + 1, parent); nodes.add(node);
        if (parent != null) parent.children.add(node); return node;
    }
    Node root() { return nodes.get(0); }
    Node find(int id) { return id >= 1 && id <= nodes.size() ? nodes.get(id - 1) : null; }
    int maxDepth() { int result = 0; for (Node node : nodes) result = Math.max(result, node.depth()); return result; }
    int maxChildren() { int result = 0; for (Node node : nodes) result = Math.max(result, node.children.size()); return result; }
    static String name(int id) { return String.format(java.util.Locale.ROOT, "traversal_node_%04d", id); }
}
