package probexperiment.http;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import probexperiment.json.Json;

import java.io.IOException;
import java.io.InputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Method-and-path dispatch with a single error boundary.
 *
 * <p>Previously each endpoint repeated its own try/catch, its own status codes
 * and its own hand-built error JSON, so the three handlers had quietly drifted
 * apart in how they reported the same kinds of failure. Registering a route
 * here means an endpoint only has to describe the happy path: malformed input
 * becomes a 400 with the parser's own message, a missing record becomes a 404,
 * and anything unforeseen becomes a 500 that is logged rather than leaked.
 */
public final class Router implements HttpHandler {
    /** A route body. Returning a string means 200 unless the route says otherwise. */
    public interface Handler {
        String handle(Request request) throws Exception;
    }

    /** Everything a handler is allowed to know about the call. */
    public record Request(String method, String path, String tail, String body) {
    }

    /** Signals a specific HTTP status from inside a handler. */
    public static final class HttpError extends RuntimeException {
        private final int status;

        public HttpError(int status, String message) {
            super(message);
            this.status = status;
        }

        public int status() {
            return status;
        }
    }

    public static HttpError notFound(String message) {
        return new HttpError(404, message);
    }

    public static HttpError badRequest(String message) {
        return new HttpError(400, message);
    }

    private record Route(String method, String prefix, boolean capturesTail, int successStatus, Handler handler) {
        boolean matches(String requestMethod, String requestPath) {
            if (!method.equals(requestMethod)) return false;
            if (capturesTail) return requestPath.startsWith(prefix) && requestPath.length() > prefix.length();
            return prefix.equals(requestPath);
        }
    }

    private final List<Route> routes = new ArrayList<>();

    /** Exact-path route. */
    public Router route(String method, String path, int successStatus, Handler handler) {
        routes.add(new Route(method, path, false, successStatus, handler));
        return this;
    }

    public Router route(String method, String path, Handler handler) {
        return route(method, path, 200, handler);
    }

    /**
     * Route matching {@code prefix} plus a trailing segment, delivered to the
     * handler as {@link Request#tail()}. The tail is restricted to characters
     * that are safe as a file name, so a handler can never be handed a path
     * traversal attempt to validate for itself.
     */
    public Router routeWithTail(String method, String prefix, Handler handler) {
        routes.add(new Route(method, prefix, true, 200, handler));
        return this;
    }

    @Override
    public void handle(HttpExchange exchange) throws IOException {
        String method = exchange.getRequestMethod();
        String path = exchange.getRequestURI().getPath();
        for (Route route : routes) {
            if (!route.matches(method, path)) continue;
            String tail = route.capturesTail()
                    ? URLDecoder.decode(path.substring(route.prefix().length()), StandardCharsets.UTF_8)
                    : "";
            respond(exchange, route, tail);
            return;
        }
        boolean pathExists = routes.stream().anyMatch(route -> route.capturesTail()
                ? path.startsWith(route.prefix())
                : route.prefix().equals(path));
        int status = pathExists ? 405 : 404;
        send(exchange, status, errorJson(pathExists ? "Method not allowed" : "No such endpoint"));
    }

    private void respond(HttpExchange exchange, Route route, String tail) throws IOException {
        try {
            if (route.capturesTail() && !tail.matches("[a-zA-Z0-9-]+")) {
                throw badRequest("Invalid identifier");
            }
            String body = readBody(exchange);
            String result = route.handler().handle(new Request(route.method(), exchange.getRequestURI().getPath(), tail, body));
            send(exchange, route.successStatus(), result);
        } catch (HttpError error) {
            send(exchange, error.status(), errorJson(error.getMessage()));
        } catch (Json.JsonException malformed) {
            send(exchange, 400, errorJson(malformed.getMessage()));
        } catch (IllegalArgumentException invalid) {
            send(exchange, 400, errorJson(invalid.getMessage()));
        } catch (Exception unexpected) {
            unexpected.printStackTrace();
            send(exchange, 500, errorJson("The engine could not complete this request"));
        }
    }

    private static String readBody(HttpExchange exchange) throws IOException {
        try (InputStream input = exchange.getRequestBody()) {
            return new String(input.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static String errorJson(String message) {
        return "{\"error\":\"" + Json.escape(message == null ? "Unexpected server error" : message) + "\"}";
    }

    private static void send(HttpExchange exchange, int status, String json) throws IOException {
        byte[] content = json.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, content.length);
        exchange.getResponseBody().write(content);
        exchange.close();
    }
}
