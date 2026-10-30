package com.artemis.helper;

import java.io.IOException;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.util.zip.CRC32;
import java.util.zip.Deflater;

/** Lossless PNG for straight, 8-bit sRGB ARGB rows. No Android dependency or pixel conversion. */
public final class InspectorPngCodec {
    public static final int MAX_DIMENSION = 16384;
    public static final long MAX_PIXELS = 16L * 1024 * 1024;
    public static final int MAX_BYTES = 16 * 1024 * 1024;
    private static final byte[] SIGNATURE = {(byte)137, 80, 78, 71, 13, 10, 26, 10};
    private InspectorPngCodec() {}

    public interface Rows { void read(int y, int[] argb) throws IOException; }

    public static void checkDimensions(int width, int height) throws IOException {
        if (width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION
                || (long) width * height > MAX_PIXELS) throw new IOException("PNG dimensions exceed observation limits");
    }

    public static void checkInterrupted() throws InterruptedIOException {
        if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("PNG encoding interrupted");
    }

    public static final class SizeLimit extends IOException {
        SizeLimit() { super("PNG exceeds observation byte limit"); }
    }

    /** Bounds encoded output, including native fallback; does not close the caller's stream. */
    public static final class LimitedOutput extends OutputStream {
        private final OutputStream destination;
        private int count;
        public LimitedOutput(OutputStream destination) {
            if (destination == null) throw new NullPointerException("PNG output");
            this.destination = destination;
        }
        @Override public void write(int value) throws IOException {
            if (count == MAX_BYTES) throw new SizeLimit();
            destination.write(value); count++;
        }
        @Override public void write(byte[] bytes, int offset, int length) throws IOException {
            if (bytes == null) throw new NullPointerException("PNG bytes");
            if (offset < 0 || length < 0 || offset > bytes.length - length) throw new IndexOutOfBoundsException();
            if (length > MAX_BYTES - count) throw new SizeLimit();
            destination.write(bytes, offset, length); count += length;
        }
    }

    public static void encode(int width, int height, Rows rows, OutputStream destination) throws IOException {
        checkDimensions(width, height);
        if (rows == null) throw new NullPointerException("PNG rows");
        checkInterrupted();
        OutputStream output = new LimitedOutput(destination);
        output.write(SIGNATURE);
        byte[] header = new byte[13];
        putInt(header, 0, width); putInt(header, 4, height);
        header[8] = 8; header[9] = 6; // 8-bit RGBA, no interlace.
        chunk(output, "IHDR", header, header.length);
        chunk(output, "sRGB", new byte[] {0}, 1);
        int[] pixels = new int[width];
        byte[] row = new byte[width * 4 + 1];
        byte[] compressed = new byte[64 * 1024];
        Deflater deflater = new Deflater(Deflater.BEST_SPEED);
        try {
            for (int y = 0; y < height; y++) {
                checkInterrupted();
                rows.read(y, pixels);
                row[0] = 1; // Sub filtering is reversible and cheap; alpha is never discarded.
                int previous = 0;
                for (int x = 0, p = 1; x < width; x++) {
                    int color = pixels[x];
                    row[p++] = (byte) ((color >>> 16) - (previous >>> 16));
                    row[p++] = (byte) ((color >>> 8) - (previous >>> 8));
                    row[p++] = (byte) (color - previous);
                    row[p++] = (byte) ((color >>> 24) - (previous >>> 24));
                    previous = color;
                }
                deflater.setInput(row);
                while (!deflater.needsInput()) {
                    int length = deflater.deflate(compressed);
                    if (length > 0) chunk(output, "IDAT", compressed, length);
                    else if (!deflater.needsInput()) throw new IOException("PNG compressor made no progress");
                }
            }
            deflater.finish();
            while (!deflater.finished()) {
                checkInterrupted();
                int length = deflater.deflate(compressed);
                if (length <= 0) throw new IOException("PNG compressor did not finish");
                chunk(output, "IDAT", compressed, length);
            }
            chunk(output, "IEND", new byte[0], 0);
        } finally { deflater.end(); }
    }

    private static void chunk(OutputStream output, String name, byte[] bytes, int length) throws IOException {
        byte[] type = new byte[] {(byte)name.charAt(0), (byte)name.charAt(1), (byte)name.charAt(2), (byte)name.charAt(3)};
        writeInt(output, length); output.write(type); output.write(bytes, 0, length);
        CRC32 crc = new CRC32(); crc.update(type); crc.update(bytes, 0, length);
        writeInt(output, (int)crc.getValue());
    }

    private static void putInt(byte[] bytes, int at, int value) {
        bytes[at] = (byte)(value >>> 24); bytes[at + 1] = (byte)(value >>> 16);
        bytes[at + 2] = (byte)(value >>> 8); bytes[at + 3] = (byte)value;
    }
    private static void writeInt(OutputStream output, int value) throws IOException {
        output.write(value >>> 24); output.write(value >>> 16); output.write(value >>> 8); output.write(value);
    }
}
