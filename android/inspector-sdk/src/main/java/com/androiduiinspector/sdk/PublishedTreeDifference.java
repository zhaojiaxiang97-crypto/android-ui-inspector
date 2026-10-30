package com.androiduiinspector.sdk;

/** Pure immutable diagnostic. No Views, pixels or user text escape the UI task. */
final class PublishedTreeDifference {
    final String wire;
    private PublishedTreeDifference(String wire) { this.wire = wire; }
    static PublishedTreeDifference compare(int[] expected, int[] actual, boolean sameRoot,
            boolean attached, boolean sameOwner, boolean shown, String phase, long ageMs) {
        String reason = !sameRoot ? "root" : !attached ? "detached" : !sameOwner ? "owner"
                : !shown ? "hidden" : expected == null ? "missing"
                : Math.abs((long) actual[0] - expected[0]) > 1 || Math.abs((long) actual[1] - expected[1]) > 1 ? "position"
                : actual[2] != expected[2] || actual[3] != expected[3] ? "size" : null;
        if (reason == null) return null;
        StringBuilder out = new StringBuilder("1;").append(phase).append(';').append(reason).append(';').append(ageMs);
        for (int i = 0; i < 4; i++) out.append(';').append(expected == null ? "-" : String.valueOf(expected[i]));
        for (int value : actual) out.append(';').append(value);
        out.append(';').append(sameRoot ? 1 : 0).append(';').append(attached ? 1 : 0)
                .append(';').append(sameOwner ? 1 : 0).append(';').append(shown ? 1 : 0);
        return new PublishedTreeDifference(out.toString());
    }
}
