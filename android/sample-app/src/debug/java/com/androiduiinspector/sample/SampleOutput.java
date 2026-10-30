package com.androiduiinspector.sample;

import java.io.BufferedOutputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.security.DigestOutputStream;
import java.security.MessageDigest;

/** Sample-only output candidate and one-shot I/O faults; never used by the SDK. */
final class SampleOutput {
    static final int BUFFER_BYTES = 64 * 1024;
    final FileOutputStream file;
    final DataOutputStream data;
    final String fault;
    boolean injected;
    long closeNanos;
    final MessageDigest digest;
    final File target;

    SampleOutput(File target, boolean buffered, String fault) throws IOException {
        this(target, buffered, fault, false);
    }
    SampleOutput(File target, boolean buffered, String fault, boolean digestEnabled) throws IOException {
        this.fault = fault;
        this.target = target;
        try { digest = digestEnabled ? MessageDigest.getInstance("SHA-256") : null; }
        catch (java.security.NoSuchAlgorithmException error) { throw new IOException(error); }
        file = new FileOutputStream(target);
        OutputStream sink = file;
        if (fault != null) sink = new OutputStream() {
            private void fail(String phase) throws IOException {
                if (!injected && phase.equals(fault)) { injected = true; throw new IOException("sample-output-" + phase); }
            }
            @Override public void write(int value) throws IOException { fail("write"); file.write(value); }
            @Override public void write(byte[] values, int offset, int length) throws IOException { fail("write"); file.write(values, offset, length); }
            @Override public void flush() throws IOException { file.flush(); fail("flush"); }
            @Override public void close() throws IOException { file.close(); fail("close"); }
        };
        if (digest != null) sink = new DigestOutputStream(sink, digest);
        data = new DataOutputStream(buffered ? new BufferedOutputStream(sink, BUFFER_BYTES) : sink);
    }
    void finish() throws IOException {
        long started = System.nanoTime();
        try { data.close(); } finally { closeNanos += System.nanoTime() - started; }
    }
    boolean descriptorClosed() throws IOException { return !file.getFD().valid(); }
}
