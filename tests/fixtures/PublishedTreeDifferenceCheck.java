package com.androiduiinspector.sdk;

public final class PublishedTreeDifferenceCheck {
    private static void check(boolean condition) { if (!condition) throw new AssertionError("Geometry guard changed"); }
    public static void main(String[] args) {
        int[] expected = {10, 20, 30, 40};
        check(PublishedTreeDifference.compare(expected, new int[] {11, 19, 30, 40}, true, true, true, true, "before", 50) == null);
        for (String phase : new String[] {"before", "after"}) {
            int[] actual = {12, 20, 30, 40};
            PublishedTreeDifference position = PublishedTreeDifference.compare(expected, actual, true, true, true, true, phase, 50);
            actual[0] = 999; // Diagnostics are already immutable, not a live array.
            check(position.wire.contains(";12;20;30;40;"));
            System.out.println(position.wire);
        }
        System.out.println(PublishedTreeDifference.compare(expected, new int[] {10, 20, 31, 40}, true, true, true, true, "before", 50).wire);
        System.out.println(PublishedTreeDifference.compare(null, expected, true, true, true, true, "before", 50).wire);
        for (int flag = 0; flag < 4; flag++) System.out.println(PublishedTreeDifference.compare(expected, expected,
                flag != 0, flag != 1, flag != 2, flag != 3, "before", 50).wire);
        check(PublishedTreeDifference.compare(new int[] {Integer.MIN_VALUE, 0, 1, 1},
                new int[] {Integer.MAX_VALUE, 0, 1, 1}, true, true, true, true, "before", 50) != null);
    }
}
