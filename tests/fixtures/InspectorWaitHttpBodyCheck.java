import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/** Runs the generated endpoint's byte-length and UTF-8 decoding block. */
public class InspectorWaitHttpBodyCheck {
    static byte[] payload;
    static int response;
    static String received;
    static byte[] readExactly(InputStream in, int length) { return payload; }
    static void sendJson(Object output, int status, String body) { response = status; }
    static String errorJson(String message) { return message; }
    static void read(String path, int contentLength) throws Exception {
        Object output = null;
        InputStream in = null;
        String body = "";
        /* PRODUCTION_BODY */
        received = body;
    }
    static void check(boolean condition) { if (!condition) throw new AssertionError("HTTP wait body boundary failed"); }
    public static void main(String[] args) throws Exception {
        String chinese = "{\"selector\":{\"text\":\"我的收藏\"}}";
        payload = chinese.getBytes(StandardCharsets.UTF_8);
        read("/inspector/wait", payload.length);
        check(response == 0 && chinese.equals(received) && payload.length > chinese.length());
        read("/inspector/input", payload.length);
        check(response == 0 && chinese.equals(received));
        received = null; payload = "{}".getBytes(StandardCharsets.UTF_8);
        read("/inspector/wait", payload.length + 1);
        check(response == 400 && received == null);
        response = 0; payload = new byte[]{(byte) 0xc3, 0x28};
        read("/inspector/wait", payload.length);
        check(response == 400 && received == null);
        response = 0; read("/inspector/input", payload.length);
        check(response == 400 && received == null);
        response = 0; payload = "{}".getBytes(StandardCharsets.UTF_8);
        read("/inspector/input", payload.length + 1);
        check(response == 400 && received == null);
        payload = new byte[]{(byte) 0xc3, 0x28};
        response = 0;
        read("/action", payload.length);
        check(response == 0 && received != null);
        System.out.println("Chinese UTF-8 body preserved; short and malformed wait bodies rejected; upstream decoding unchanged");
    }
}
