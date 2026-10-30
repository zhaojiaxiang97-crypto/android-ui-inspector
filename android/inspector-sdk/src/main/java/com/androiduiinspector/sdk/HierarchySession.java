package com.androiduiinspector.sdk;

import android.app.Application;
import android.net.Credentials;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.os.Bundle;
import android.os.Debug;
import android.util.Log;
import org.json.JSONException;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;

/**
 * Experimental session channel: a local abstract socket serving the same handlers (line-delimited
 * JSON request, "Result: Bundle[...]" reply). Debug-only, shell/root peer UID required.
 */
final class HierarchySession {
    static final String SUFFIX = ".inspector.session";
    private final HierarchyProvider provider;
    private final LocalServerSocket server;
    private final String name;
    private final HashSet<LocalSocket> clients = new HashSet<>();
    private volatile boolean stopped;

    HierarchySession(Application app, HierarchyProvider provider) throws IOException {
        this.provider = provider;
        this.name = app.getPackageName() + SUFFIX;
        this.server = new LocalServerSocket(name);
        Thread thread = new Thread(this::loop, "inspector-session");
        thread.setDaemon(true);
        thread.start();
    }

    void touch() { }

    void close() {
        stopped = true;
        ArrayList<LocalSocket> closing;
        synchronized (clients) { closing = new ArrayList<>(clients); }
        for (LocalSocket client : closing) {
            try { client.close(); } catch (IOException ignored) { }
        }
        // Closing the server socket does not wake a blocked accept(); a self-connection does.
        try { LocalSocket wake = new LocalSocket(); wake.connect(new LocalSocketAddress(name)); wake.close(); }
        catch (IOException ignored) { }
        try { server.close(); } catch (IOException ignored) { }
    }

    private void loop() {
        while (!stopped) {
            LocalSocket client;
            try { client = server.accept(); }
            catch (IOException closed) { return; }
            synchronized (clients) {
                // An idle desktop must not block a diagnostic client. Data dispatch stays
                // serialized by the provider monitor; extra connections are not queued.
                if (stopped || clients.size() >= 2) {
                    try { client.close(); } catch (IOException ignored) { }
                    if (stopped) return;
                    continue;
                }
                clients.add(client);
            }
            boolean started = false;
            try {
                Thread worker = new Thread(() -> handle(client), "inspector-session-client");
                worker.setDaemon(true);
                worker.start();
                started = true;
            } finally {
                if (!started) {
                    synchronized (clients) { clients.remove(client); }
                    try { client.close(); } catch (IOException ignored) { }
                }
            }
        }
    }

    private void handle(LocalSocket client) {
        try {
            Credentials credentials = client.getPeerCredentials();
            int uid = credentials == null ? -1 : credentials.getUid();
            Log.i("InspectorSession", "peer uid=" + uid);
            if (uid != 2000 && uid != 0) return;
            BufferedReader reader = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
            OutputStream output = client.getOutputStream();
            String line;
            while ((line = reader.readLine()) != null) {
                Request request = Request.read(line);
                Bundle answer = provider.dispatchSession(request.method, request.arg, request.extras, uid, output);
                output.write(("Result: " + answer + "\n").getBytes(StandardCharsets.UTF_8));
                output.flush();
            }
        } catch (Exception error) {
            Log.w("InspectorSession", "request failed: " + error);
        } finally {
            try { client.close(); } catch (IOException ignored) { }
            synchronized (clients) { clients.remove(client); }
        }
    }

    /** Wire decoding only; UID/method authorization remains at the Provider boundary. */
    static final class Request {
        final String method, arg;
        final Bundle extras;
        private Request(String method, String arg, Bundle extras) { this.method = method; this.arg = arg; this.extras = extras; }
        static Request read(String line) throws org.json.JSONException {
            JSONObject request = new JSONObject(line);
            String method = request.getString("method");
            String arg = request.isNull("arg") ? null : request.optString("arg", null);
            Bundle extras = new Bundle();
            JSONObject wanted = request.optJSONObject("extras");
            if (wanted != null) {
                for (Iterator<String> keys = wanted.keys(); keys.hasNext(); ) {
                    String key = keys.next();
                    Object value = wanted.get(key);
                    if (value instanceof Boolean) extras.putBoolean(key, (Boolean) value);
                    else extras.putString(key, String.valueOf(value));
                }
            }
            return new Request(method, arg, extras);
        }
    }
}
