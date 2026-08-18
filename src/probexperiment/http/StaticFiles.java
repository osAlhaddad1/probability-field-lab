package probexperiment.http;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;

import java.io.IOException;
import java.io.InputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Serves the dashboard, preferring files on disk so a running server picks up
 * frontend edits, and falling back to the copy embedded in the JAR.
 */
public final class StaticFiles implements HttpHandler {
    private final Path root;
    private final String resourcePrefix;

    public StaticFiles(Path root, String resourcePrefix) {
        this.root = root;
        this.resourcePrefix = resourcePrefix;
    }

    @Override
    public void handle(HttpExchange exchange) throws IOException {
        if (!"GET".equals(exchange.getRequestMethod())) {
            exchange.sendResponseHeaders(405, -1);
            exchange.close();
            return;
        }
        String urlPath = URLDecoder.decode(exchange.getRequestURI().getPath(), StandardCharsets.UTF_8);
        if ("/".equals(urlPath)) urlPath = "/index.html";
        String relativePath = urlPath.substring(1).replace('\\', '/');

        Path normalised;
        try {
            normalised = Path.of(relativePath).normalize();
        } catch (RuntimeException invalid) {
            notFound(exchange);
            return;
        }
        if (normalised.isAbsolute() || normalised.startsWith("..")) {
            notFound(exchange);
            return;
        }

        Path file = root.resolve(normalised).normalize();
        byte[] content;
        String type;
        if (file.startsWith(root) && Files.isRegularFile(file)) {
            content = Files.readAllBytes(file);
            type = Files.probeContentType(file);
        } else {
            String resourcePath = resourcePrefix + normalised.toString().replace('\\', '/');
            try (InputStream input = StaticFiles.class.getResourceAsStream(resourcePath)) {
                if (input == null) {
                    notFound(exchange);
                    return;
                }
                content = input.readAllBytes();
            }
            type = null;
        }
        if (type == null) type = contentType(relativePath);
        exchange.getResponseHeaders().set("Content-Type", type + "; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-cache");
        exchange.sendResponseHeaders(200, content.length);
        exchange.getResponseBody().write(content);
        exchange.close();
    }

    private static void notFound(HttpExchange exchange) throws IOException {
        exchange.sendResponseHeaders(404, -1);
        exchange.close();
    }

    private static String contentType(String path) {
        String lower = path.toLowerCase();
        if (lower.endsWith(".html")) return "text/html";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".js")) return "text/javascript";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".ico")) return "image/x-icon";
        return "application/octet-stream";
    }
}
