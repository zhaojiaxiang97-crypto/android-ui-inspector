import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Runs the actual SDK Session class with Java TCP substitutes. Not an Android LocalSocket/UID test.
test("SDK accepts a diagnostic client beside an idle desktop client, bounds clients and closes them", () => {
  const source = readFileSync(join(import.meta.dirname, "../android/inspector-sdk/src/main/java/com/androiduiinspector/sdk/HierarchyProvider.java"), "utf8");
  const transport = readFileSync(join(import.meta.dirname, "../android/inspector-sdk/src/main/java/com/androiduiinspector/sdk/HierarchySession.java"), "utf8");
  const start = transport.indexOf("final class HierarchySession {");
  const routeStart = source.indexOf("    Bundle dispatchSession(");
  const routeEnd = source.indexOf("    private void notifyTreeReady(", routeStart);
  const diagnosticStart = source.indexOf("    private static boolean isDiagnosticMethod(");
  const diagnosticEnd = source.indexOf("    // Scalar snapshots only:", diagnosticStart);
  assert(start > 0 && routeStart > 0 && routeEnd > routeStart);
  assert(diagnosticStart > 0 && diagnosticEnd > diagnosticStart);
  assert.match(source, /private synchronized Bundle dispatch\(/); // Data handlers remain serialized.
  const directory = mkdtempSync(join(tmpdir(), "sdk-session-clients-"));
  try {
    writeFileSync(join(directory, "HierarchyProvider.java"), `
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
public class HierarchyProvider {
  static final String SESSION_SUFFIX=".inspector.session";
  final ThreadLocal<OutputStream> treeReadyOutput=new ThreadLocal<>();
  final CountDownLatch entered=new CountDownLatch(1), release=new CountDownLatch(1);
  final AtomicInteger inDispatch=new AtomicInteger(), maxDispatch=new AtomicInteger(), calls=new AtomicInteger();
  static boolean isDataMethod(String method){return method.equals("capture");}
${source.slice(diagnosticStart, diagnosticEnd)}
  Bundle readDiagnostic(String method,String arg,Bundle extra,int uid){
    Bundle b=new Bundle();b.putString(uid==2000?"result":"error",uid==2000?"ok":"Unauthorized");return b;
  }
${source.slice(routeStart, routeEnd)}
  private synchronized Bundle dispatch(String method,String arg,Bundle extra) {
    int active=inDispatch.incrementAndGet();maxDispatch.accumulateAndGet(active,Math::max);calls.incrementAndGet();
    try {
      entered.countDown();
      try {check(release.await(1,TimeUnit.SECONDS),"dispatch released");}
      catch(InterruptedException error){Thread.currentThread().interrupt();throw new RuntimeException(error);}
      Bundle reply=new Bundle();reply.putString("result","ok");return reply;
    } finally {inDispatch.decrementAndGet();}
  }
  static class Application {String getPackageName(){return "fixture.app";}}
  static class Credentials {final int uid;Credentials(int u){uid=u;}int getUid(){return uid;}}
  static class LocalSocketAddress {final String name;LocalSocketAddress(String n){name=n;}}
  static class LocalSocket {
    Socket socket;final int uid;
    LocalSocket(){uid=2000;}
    LocalSocket(Socket s,int u){socket=s;uid=u;}
    void connect(LocalSocketAddress address) throws IOException {socket=new Socket("127.0.0.1",LocalServerSocket.port);}
    Credentials getPeerCredentials(){return new Credentials(uid);}
    InputStream getInputStream() throws IOException {return socket.getInputStream();}
    OutputStream getOutputStream() throws IOException {return socket.getOutputStream();}
    void close() throws IOException {if(socket!=null)socket.close();}
  }
  static class LocalServerSocket {
    static volatile int port, nextUid=2000;
    static final AtomicInteger accepted=new AtomicInteger();
    final ServerSocket server;
    LocalServerSocket(String name) throws IOException {server=new ServerSocket(0,8,InetAddress.getByName("127.0.0.1"));port=server.getLocalPort();}
    LocalSocket accept() throws IOException {Socket s=server.accept();accepted.incrementAndGet();return new LocalSocket(s,nextUid);}
    void close() throws IOException {server.close();}
  }
  static class Log {static void i(String tag,String message){}static void w(String tag,String message){}}
  static class Bundle {
    final Map<String,Object> values=new LinkedHashMap<>();
    void putString(String key,String value){values.put(key,value);}
    void putBoolean(String key,boolean value){values.put(key,value);}
    boolean getBoolean(String key,boolean fallback){Object v=values.get(key);return v instanceof Boolean?(Boolean)v:fallback;}
    public String toString(){return "Bundle["+values+"]";}
  }
  static class JSONObject {
    final String line;JSONObject(String s){line=s;}
    String getString(String key){for(String method:new String[]{"session-probe","read-diagnostic-identity","read-sdk-build","read-tree-task","capture"})if(line.contains(method))return method;throw new IllegalArgumentException();}
    boolean isNull(String key){return true;}
    String optString(String key,String fallback){return fallback;}
    JSONObject optJSONObject(String key){return null;}
    Iterator<String> keys(){return Collections.emptyIterator();}
    Object get(String key){return null;}
  }
${transport.slice(start).replace("final class HierarchySession {", "static final class HierarchySession {").replace("throws org.json.JSONException", "throws Exception")}
  interface Condition {boolean ready();}
  static void check(boolean ok,String why){if(!ok)throw new AssertionError(why);}
  static void waitFor(Condition condition,String why) throws Exception {
    long until=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(700);
    while(!condition.ready()&&System.nanoTime()<until)Thread.sleep(2);
    check(condition.ready(),why);
  }
  static long threads(String name){return Thread.getAllStackTraces().keySet().stream().filter(t->t.isAlive()&&t.getName().equals(name)).count();}
  static Socket connect() throws Exception {Socket socket=new Socket("127.0.0.1",LocalServerSocket.port);socket.setSoTimeout(700);return socket;}
  static void send(Socket socket,String method) throws Exception {
    socket.getOutputStream().write(("{\\"method\\":\\""+method+"\\",\\"arg\\":null,\\"extras\\":{}}\\n").getBytes(StandardCharsets.UTF_8));socket.getOutputStream().flush();
  }
  static String read(Socket socket) throws Exception {return new BufferedReader(new InputStreamReader(socket.getInputStream(),StandardCharsets.UTF_8)).readLine();}
  static void probe(Socket socket) throws Exception {send(socket,"session-probe");check("Result: Bundle[{error=Unknown session method}]".equals(read(socket)),"probe reply");}
  static boolean refused(Socket socket) throws Exception {
    try {send(socket,"session-probe");return read(socket)==null;}
    catch(SocketTimeoutException error){throw error;}
    catch(SocketException closed){return true;}
  }
  public static void main(String[] args) throws Exception {
    HierarchyProvider provider=new HierarchyProvider();HierarchySession session=new HierarchySession(new Application(),provider);
    List<Socket> owned=new ArrayList<>();
    try {
      Socket desktop=connect();owned.add(desktop);
      waitFor(()->LocalServerSocket.accepted.get()>=1,"desktop accepted idle");
      Socket diagnostic=connect();owned.add(diagnostic);probe(diagnostic);probe(desktop);
      check(threads("inspector-session-client")==2,"two bounded client workers");
      Socket third=connect();owned.add(third);check(refused(third),"third client refused rather than queued");
      send(diagnostic,"capture");check(provider.entered.await(700,TimeUnit.MILLISECONDS),"data entered");
      for(String method:new String[]{"read-diagnostic-identity","read-sdk-build","read-tree-task"}) {
        send(desktop,method);check("Result: Bundle[{result=ok}]".equals(read(desktop)),"scalar read beside blocked capture: "+method);
      }
      check(provider.calls.get()==1,"scalar reads bypass data monitor");
      desktop.close();waitFor(()->threads("inspector-session-client")==1,"desktop worker released");
      LocalServerSocket.nextUid=10001;
      Socket denied=connect();owned.add(denied);check(refused(denied),"non-shell/root rejected");
      waitFor(()->threads("inspector-session-client")==1,"denied worker released");
      LocalServerSocket.nextUid=0;
      Socket root=connect();owned.add(root);probe(root);
      for(String method:new String[]{"read-diagnostic-identity","read-sdk-build","read-tree-task"}) {
        send(root,method);check("Result: Bundle[{error=Unauthorized}]".equals(read(root)),"scalar shell-only authorization: "+method);
      }
      probe(root);check(provider.calls.get()==1,"probe independent of data monitor");
      send(root,"capture");provider.release.countDown();
      check("Result: Bundle[{result=ok}]".equals(read(diagnostic)),"first data reply");
      check("Result: Bundle[{result=ok}]".equals(read(root)),"second data reply");
      check(provider.calls.get()==2&&provider.maxDispatch.get()==1,"data dispatch serialized");
      session.close();check(read(diagnostic)==null&&read(root)==null,"session close releases idle clients");
      waitFor(()->threads("inspector-session-client")==0&&threads("inspector-session")==0,"all session threads finished");
      System.out.println("8 SDK client checks passed");
    } finally {
      provider.release.countDown();session.close();for(Socket socket:owned)socket.close();
    }
  }
}`);
    const compiled = spawnSync("javac", ["--release", "8", "-d", directory, join(directory, "HierarchyProvider.java")], { encoding: "utf8", timeout: 20000 });
    assert.equal(compiled.status, 0, compiled.stderr);
    const run = spawnSync("java", ["-cp", directory, "HierarchyProvider"], { encoding: "utf8", timeout: 5000 });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /8 SDK client checks passed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
