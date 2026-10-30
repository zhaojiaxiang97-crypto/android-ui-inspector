// Injected into the existing fault-injectable Android adapters, after the production methods.
    static long timingNano, localCost = 100000, childCost = 250000, recycleCost = 10000;
    static void advanceTiming(long amount) { timingNano += amount; }
    static SnapshotTimings profile() { return new SnapshotTimings(0, 0, () -> timingNano); }
    static Map<String, String> fields(String header) {
        check(header != null && header.length() <= 512 && !header.contains(PRIVATE), "bounded numeric header required");
        Map<String, String> result = new LinkedHashMap<>();
        for (String field : header.split(";")) {
            String[] pair = field.split("=");
            check(pair.length == 2 && result.put(pair[0], pair[1]) == null, "unique header keys");
            check(pair[0].equals("v") ? pair[1].equals("1") : pair[1].matches("[0-9]+\\.[0-9]{3}"), "numeric fixed format");
        }
        return result;
    }
    static Map<String, String> finish(SnapshotTimings timing, JSONObject body) {
        timing.finishObservation();
        byte[] bytes = timing.serialize(body);
        check(bytes.length > 0, "response body lost");
        return fields(timing.header());
    }
    public static void main(String[] args) throws Exception {
        AccessibilityWindowInfo window = reset();
        AccessibilityNodeInfo child = new AccessibilityNodeInfo(), grandchild = new AccessibilityNodeInfo();
        window.root.children.add(child); child.children.add(grandchild);
        JSONObject baseline = snapshot(new AccessibilityService());
        String originalXml = baseline.getString("xml"), originalTiming = baseline.getJSONObject("helperObservation").getJSONObject("timing").toString();
        window = reset(); window.root.children.add(child); timingNano = 0;
        SnapshotTimings timing = profile(); timing.startObservation();
        JSONObject body = snapshot(new AccessibilityService(), timing);
        Map<String, String> measured = finish(timing, body);
        check(body.getString("xml").equals(originalXml) && body.getInt("node_count") == 3, "profiling changed XML or traversal");
        check(body.getJSONObject("helperObservation").getJSONObject("timing").toString().equals(originalTiming), "v1 timing JSON changed");
        check(measured.get("cacheClearMs").equals("2.000") && measured.get("initialWindowReadMs").equals("7.000"), "clear cache / display plus roots split");
        check(measured.get("getChildMs").equals("0.500"), "getChild calls accumulated once");
        check(measured.get("nodeLocalMs").equals("0.320"), "local work must exclude direct getChild and recursive subtrees");

        window = reset(); timingNano = 0; localCost = recycleCost = 0; childCost = 1000;
        for (int i = 0; i < 200; i++) window.root.children.add(new AccessibilityNodeInfo());
        timing = profile(); timing.startObservation(); body = snapshot(new AccessibilityService(), timing);
        measured = finish(timing, body);
        check(measured.get("getChildMs").equals("0.200"), "sub-ms calls must accumulate before conversion");
        check(measured.get("nodeLocalMs").equals("0.000") && body.getInt("node_count") == 201, "zero work and full traversal preserved");
        localCost = 100000; childCost = 250000; recycleCost = 10000;

        reset(); Build.VERSION.SDK_INT = 32; timingNano = 0;
        timing = profile(); timing.startObservation(); body = snapshot(new AccessibilityService(), timing); measured = finish(timing, body);
        check(!measured.containsKey("cacheClearMs") && measured.get("getChildMs").equals("0.000"), "old API skips cache timing; leaf traversal actually did zero child calls");
        reset(); scenario.cacheCleared = false; timingNano = 0;
        timing = profile(); timing.startObservation(); body = snapshot(new AccessibilityService(), timing); measured = finish(timing, body);
        check(!body.getBoolean("success") && !body.getJSONObject("helperObservation").getBoolean("complete"), "failed cache gate changed");
        check(measured.containsKey("cacheClearMs") && !measured.containsKey("initialWindowReadMs")
                && !measured.containsKey("getChildMs") && !measured.containsKey("nodeLocalMs"), "unstarted work must remain absent");

        for (boolean throwing : new boolean[]{false, true}) {
            window = reset(); timingNano = 0; window.root.childFailure = throwing;
            window.root.children.add(null); timing = profile(); timing.startObservation();
            body = snapshot(new AccessibilityService(), timing); measured = finish(timing, body);
            check(!body.getJSONObject("helperObservation").getBoolean("complete"), "child failure became complete");
            check(measured.get("getChildMs").equals("0.250"), "null/throwing getChild still measured");
        }
        timingNano = 0;
        SnapshotTimings invalid = new SnapshotTimings(-60000000001L, 0, () -> timingNano);
        invalid.startObservation(); invalid.finishObservation(); invalid.serialize(new JSONObject());
        check(invalid.header() == null, "oversize queue omitted as diagnostics, not capture failure");
        java.lang.System.out.println("snapshot timing preserves capture; exclusive recursive accounting, sub-ms accumulation, failures and old API checked");
    }
