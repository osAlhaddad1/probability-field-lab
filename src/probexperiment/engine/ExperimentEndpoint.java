package probexperiment.engine;

import probexperiment.http.Router;
import probexperiment.json.Json;
import probexperiment.json.JsonNode;
import probexperiment.json.JsonWriter;
import probexperiment.store.RunStore;

import java.util.List;
import java.util.Map;

/**
 * Gives an {@link Experiment} its four REST routes.
 *
 * <p>Every mode wants the same endpoints — run, list, fetch, discard — and
 * previously each one grew its own slightly different copy of them. Registering
 * through here means a new mode inherits identical semantics for free, and a
 * change to how results are listed or discarded happens once.
 */
public final class ExperimentEndpoint {
    private ExperimentEndpoint() {
    }

    public static void register(Router router, Experiment experiment, RunStore store) {
        String base = "/api/" + experiment.path();

        router.route("POST", base, 201, request -> {
            JsonNode body = request.body() == null || request.body().isBlank()
                    ? JsonNode.of(Map.of())
                    : Json.parseObject(request.body());
            Experiment.Result result = experiment.run(body);
            store.save(result.id(), result.json());
            return result.json();
        });

        router.route("GET", base, request -> index(store));

        router.routeWithTail("GET", base + "/", request -> store.load(request.tail())
                .orElseThrow(() -> Router.notFound("No stored result with that identifier")));

        router.routeWithTail("DELETE", base + "/", request -> {
            if (!store.trash(request.tail())) {
                throw Router.notFound("No stored result with that identifier");
            }
            return new JsonWriter(96).beginObject()
                    .field("deleted", true)
                    .field("recoverable", true)
                    .field("id", request.tail())
                    .endObject()
                    .toString();
        });
    }

    /** Renders index entries, preserving each stored field's original JSON type. */
    private static String index(RunStore store) throws Exception {
        List<Map<String, Object>> entries = store.index();
        JsonWriter json = new JsonWriter(256 + entries.size() * 220);
        json.beginArray();
        for (Map<String, Object> entry : entries) {
            json.beginObject();
            for (Map.Entry<String, Object> field : entry.entrySet()) {
                Object value = field.getValue();
                if (value instanceof Long whole) json.field(field.getKey(), (long) whole);
                else if (value instanceof Double number) json.field(field.getKey(), (double) number);
                else if (value instanceof String text) json.field(field.getKey(), text);
                else if (value instanceof Boolean flag) json.field(field.getKey(), (boolean) flag);
                else json.name(field.getKey()).nullValue();
            }
            json.endObject();
        }
        return json.endArray().toString();
    }
}
