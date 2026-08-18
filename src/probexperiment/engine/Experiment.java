package probexperiment.engine;

import probexperiment.json.JsonNode;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import java.util.function.IntFunction;

/**
 * One mode of the lab.
 *
 * <p>An experiment reads a validated request and returns a finished result
 * document. It knows nothing about HTTP, storage or the shape of the URL it was
 * reached through, so adding a mode is a matter of writing one of these and
 * registering it — see {@link ExperimentEndpoint}.
 */
public interface Experiment {
    /** URL segment beneath {@code /api/}, which is also the storage folder name. */
    String path();

    /** Human-readable label, used in start-up logging. */
    String title();

    /** Runs the experiment. Throwing {@link IllegalArgumentException} produces a 400. */
    Result run(JsonNode request) throws Exception;

    /** A completed result and the identifier it is stored under. */
    record Result(String id, String json) {
    }

    /** Sortable-by-name identifier: newest files sort last, which the index relies on. */
    static String newId() {
        return Instant.now().toEpochMilli() + "-" + UUID.randomUUID().toString().substring(0, 8);
    }

    /**
     * Splits {@code total} units of work across shards and runs them on virtual
     * threads.
     *
     * <p>Sharding rather than one task per unit: a run can involve millions of
     * agents, and one task each would spend more time creating and joining
     * tasks than sampling. Each shard walks a strided subset, so the split
     * never affects which seed a unit gets and a result stays reproducible from
     * its seed no matter how the work was divided.
     */
    static <T> List<T> shard(int total, IntFunction<T> shardBody, int shardCount) throws Exception {
        int shards = Math.max(1, Math.min(shardCount, total));
        List<Callable<T>> tasks = new ArrayList<>(shards);
        for (int index = 0; index < shards; index++) {
            final int shard = index;
            tasks.add(() -> shardBody.apply(shard));
        }
        List<T> results = new ArrayList<>(shards);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            for (var future : executor.invokeAll(tasks)) results.add(future.get());
        }
        return results;
    }

    /** Default shard count: enough to fill the machine without fragmenting accumulators. */
    static int defaultShards() {
        return Math.max(1, Math.min(64, Runtime.getRuntime().availableProcessors() * 2));
    }
}
