// Exact pinned CommandServer seams used by the patch tests; the offline APK also compiles the full upstream file.
export const commandTimingSource = `
    void submit(final Socket socket) {
                clientExecutor.execute(new Runnable() {
                    @Override
                    public void run() {
                        handleClient(socket);
                    }
                });
    }
    private void handleClient(Socket socket) {
                handleHttp(ascii, in, output);
    }
    private void handleHttp(String requestLine, InputStream in, OutputStream output) {
    }
    private static void send(OutputStream output, int status, String contentType, byte[] bytes) {
        try {
            String header = "HTTP/1.1 " + status + " " + reason(status) + "\\r\\n" +
                    "Content-Type: " + contentType + "; charset=utf-8\\r\\n" +
                    "Content-Length: " + bytes.length + "\\r\\n" +
                    "Connection: close\\r\\n\\r\\n";
            output.write(header.getBytes(StandardCharsets.UTF_8));
            output.write(bytes);
            output.flush();
        } catch (Exception ignored) {}
    }
`;
