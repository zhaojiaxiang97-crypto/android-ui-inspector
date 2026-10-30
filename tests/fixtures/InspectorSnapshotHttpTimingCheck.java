import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Generated route, worker handoff and body sender run against a controlled monotonic clock. */
public class InspectorSnapshotHttpTimingCheck {
    static final String PRIVATE = "private-token-page-中文";
    static final String BODY = "{\"text\":\"" + PRIVATE + "\"}";
    static class System { static long now; static long nanoTime() { return now; } }
    static int serializations, observations;
    static void advance(long nanos) { System.now += nanos; }
    static class JSONException extends Exception {}
    static class JSONObject {
        final String body;
        JSONObject() { this("{}"); }
        JSONObject(String body) { this.body = body; }
        Object opt(String key) { if (key.equals("success")) advance(2000000); return null; }
        Object get(String key) throws JSONException { throw new JSONException(); }
        JSONObject put(String key, Object value) throws JSONException { return this; }
        Iterator<String> keys() { return Collections.<String>emptyList().iterator(); }
        public String toString() { serializations++; advance(1000000); return body; }
    }
    static class Service {}
    static final Service service = new Service();
    static class TokenStore { static boolean matches(String token) { return true; } }
    static class ArtemisAccessibilityService { static Service getInstance() { return service; } }
    static class InspectorInput { static JSONObject execute(Service s, String body, java.util.function.BooleanSupplier auth) { return new JSONObject("{}"); } }
    static class InspectorTargetProbe { static JSONObject execute(Service s, String body, java.util.function.BooleanSupplier auth) { return new JSONObject("{}"); } }
    static class InspectorWindowState { static JSONObject execute(Service s, String body, java.util.function.BooleanSupplier auth) { return new JSONObject("{}"); } }
    /* SNAPSHOT_JSON */
    static class InspectorObservation {
        /* SNAPSHOT_TIMINGS */
        static JSONObject capabilities(Service s) { return new JSONObject("{}"); }
        static JSONObject waitForCondition(Service s, String body, java.util.function.BooleanSupplier auth) { return new JSONObject("{}"); }
        static JSONObject snapshot(Service s, SnapshotTimings timing) { observations++; advance(20000000); return new JSONObject(BODY); }
    }
    static class Socket { final String path, method; final boolean authed; Socket(String path, String method, boolean authed) { this.path=path;this.method=method;this.authed=authed; } }
    static class Executor { Runnable queued; void execute(Runnable item) { queued=item; } }
    final Executor clientExecutor = new Executor();
    final ByteArrayOutputStream output = new ByteArrayOutputStream();
    /* WORKER */
    private void handleClient(Socket socket, long inspectorSubmittedNs, long inspectorWorkerStartedNs) {
        advance(3000000); // HTTP reading/authentication before observation is included, not labelled CPU time.
        try { route(socket, inspectorSubmittedNs, inspectorWorkerStartedNs); } catch (Exception error) { throw new AssertionError(error); }
    }
    void route(Socket socket, long inspectorSubmittedNs, long inspectorWorkerStartedNs) throws Exception {
        String path=socket.path, body="", token="fixed"; String[] parts={socket.method};
        if (!socket.authed) { sendJson(output,401,errorJson("unauthorized").toString()); return; }
        /* ROUTES */
        sendJson(output,200,errorJson("upstream route").toString());
    }
    static JSONObject errorJson(String text) { return new JSONObject("{\"error\":\""+text+"\"}"); }
    static String reason(int status) { return status==200?"OK":status==401?"Unauthorized":"Method Not Allowed"; }
    static void sendJson(OutputStream output,int status,String text) { send(output,status,"application/json",text.getBytes(StandardCharsets.UTF_8)); }
    /* SEND */
    static void check(boolean ok,String message) { if(!ok)throw new AssertionError(message); }
    static String run(String path,String method,boolean authed,long queue) {
        System.now=0;serializations=observations=0;
        InspectorSnapshotHttpTimingCheck server=new InspectorSnapshotHttpTimingCheck();
        server.submit(new Socket(path,method,authed));advance(queue);server.clientExecutor.queued.run();
        return new String(server.output.toByteArray(),StandardCharsets.UTF_8);
    }
    public static void main(String[] args) {
        String response=run("/inspector/snapshot","GET",true,5000000);
        String expected="X-Inspector-Snapshot-Timing: v=1;queueMs=5.000;preObservationMs=3.000;observationMs=20.000;jsonSerializationMs=3.000;utf8EncodingMs=0.000\r\n";
        check(response.contains(expected),"worker/request/observation/one serialization/one UTF8 timing");
        check(response.endsWith("\r\n\r\n"+BODY),"body bytes changed");
        check(response.contains("Content-Length: "+BODY.getBytes(StandardCharsets.UTF_8).length+"\r\n"),"UTF8 byte length");
        check(response.contains("Content-Type: application/json; charset=utf-8\r\n"),"original content type");
        check(serializations==1&&observations==1,"body must serialize once");
        check(!response.substring(0,response.indexOf("\r\n\r\n")).contains(PRIVATE),"private data in headers");
        for(String path:new String[]{"/inspector/capabilities","/inspector/wait","/inspector/input","/inspector/target-probe","/snapshot"}) {
            response=run(path,path.endsWith("wait")||path.endsWith("input")||path.endsWith("target-probe")?"POST":"GET",true,5000000);
            check(!response.contains("X-Inspector-Snapshot-Timing")&&observations==0,"other route received snapshot diagnostics");
            if(path.endsWith("target-probe")) check(response.startsWith("HTTP/1.1 200"),"probe route not exercised");
        }
        response=run("/inspector/snapshot","GET",false,5000000);
        check(response.startsWith("HTTP/1.1 401")&&!response.contains("X-Inspector-Snapshot-Timing")&&observations==0,"unauthorized timing leak");
        response=run("/inspector/snapshot","POST",true,5000000);
        check(response.startsWith("HTTP/1.1 405")&&!response.contains("X-Inspector-Snapshot-Timing")&&observations==0,"wrong method timing leak");
        response=run("/inspector/snapshot","GET",true,60001000000L);
        check(response.endsWith(BODY)&&!response.contains("X-Inspector-Snapshot-Timing")&&serializations==1,"bad timing must not change valid response");
        java.lang.System.out.println("authenticated snapshot-only header, worker handoff, UTF8 body, one serialization and compatibility checked");
    }
}
