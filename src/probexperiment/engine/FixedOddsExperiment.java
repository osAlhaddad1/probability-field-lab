package probexperiment.engine;

import probexperiment.json.JsonNode;
import probexperiment.json.JsonWriter;
import probexperiment.numeric.Rng;

import java.time.Instant;
import java.util.Arrays;
import java.util.List;

/**
 * The known-odds mode: many agents each play a fixed number of independent
 * games at one probability, and every individual outcome is kept.
 *
 * <p>The outcomes are the point of this mode — the dashboard draws each one as
 * a cell — so unlike the other engines it cannot replace simulation with
 * algebra. What it can avoid is asking the generator a question per game.
 * Successes are placed by drawing the gap to the next one from a geometric
 * distribution and filling the run of failures in between with
 * {@link Arrays#fill}, which the JIT turns into a vectorised store. At the
 * default 1% rate that is one draw per hundred games instead of one per game,
 * for exactly the same distribution of outcomes.
 *
 * <p>Above roughly a quarter, gaps are short enough that a logarithm per
 * success costs more than a uniform per game, so the loop flips directly
 * instead. Both branches produce independent Bernoulli trials; only the
 * arithmetic used to get there differs.
 */
public final class FixedOddsExperiment implements Experiment {
    private static final int DEFAULT_AGENTS = 200;
    private static final int DEFAULT_GAMES = 300;
    private static final double DIRECT_FLIP_THRESHOLD = 0.25;
    private static final byte MISS = '0';
    private static final byte HIT = '1';

    @Override
    public String path() {
        return "runs";
    }

    @Override
    public String title() {
        return "Known odds";
    }

    @Override
    public Result run(JsonNode request) throws Exception {
        double successRate = request.number("successRate", 0.01, 0, 1);
        int agentCount = request.integer("agentCount", DEFAULT_AGENTS, 1, Integer.MAX_VALUE);
        int gamesPerAgent = request.integer("gamesPerAgent", DEFAULT_GAMES, 1, Integer.MAX_VALUE);
        double gameCost = request.number("gameCost", 1.0, 0, Double.MAX_VALUE);
        double winReward = request.number("winReward", 100.0, 0, Double.MAX_VALUE);
        long seed = request.seed("seed", new java.util.SplittableRandom().nextLong());

        long started = System.nanoTime();
        byte[][] outcomes = new byte[agentCount][];
        int[] successes = new int[agentCount];
        final int shards = Math.max(1, Math.min(Experiment.defaultShards(), agentCount));

        List<Long> shardTotals = Experiment.shard(agentCount, shard -> {
            Rng rng = new Rng(0);
            long total = 0;
            for (int agent = shard; agent < agentCount; agent += shards) {
                rng.reseed(Rng.derive(seed, agent + 1L, 0));
                byte[] row = new byte[gamesPerAgent];
                int hits = play(rng, row, successRate, gamesPerAgent);
                outcomes[agent] = row;
                successes[agent] = hits;
                total += hits;
            }
            return total;
        }, shards);

        long totalSuccesses = 0;
        for (long total : shardTotals) totalSuccesses += total;
        long durationMs = Math.max(1, (System.nanoTime() - started) / 1_000_000);
        String id = Experiment.newId();

        // Roughly one byte per game plus per-agent framing, so the buffer is sized once.
        long estimate = 512L + (long) agentCount * (gamesPerAgent + 48L);
        JsonWriter json = new JsonWriter((int) Math.min(Integer.MAX_VALUE - 32, estimate));
        json.beginObject()
                .field("id", id)
                .field("createdAt", Instant.now().toString())
                .field("successRate", successRate)
                .field("agentCount", (long) agentCount)
                .field("gamesPerAgent", (long) gamesPerAgent)
                .field("gameCost", gameCost)
                .field("winReward", winReward)
                .field("seed", seed)
                .field("durationMs", durationMs)
                .field("totalSuccesses", totalSuccesses)
                .field("totalGames", (long) agentCount * gamesPerAgent)
                .beginArray("agents");
        for (int agent = 0; agent < agentCount; agent++) {
            json.beginObject()
                    .field("id", (long) (agent + 1))
                    .field("successes", (long) successes[agent])
                    .asciiField("outcomes", outcomes[agent], gamesPerAgent)
                    .endObject();
            // The row has been written; release it so peak memory tracks the
            // output rather than holding the whole field twice over.
            outcomes[agent] = null;
        }
        json.endArray().endObject();
        return new Result(id, json.toString());
    }

    /** Fills one agent's row of outcomes and returns the number of successes. */
    private static int play(Rng rng, byte[] row, double successRate, int games) {
        if (successRate >= 1) {
            Arrays.fill(row, HIT);
            return games;
        }
        Arrays.fill(row, MISS);
        if (!(successRate > 0)) return 0;

        if (successRate > DIRECT_FLIP_THRESHOLD) {
            int hits = 0;
            for (int game = 0; game < games; game++) {
                if (rng.nextDouble() < successRate) {
                    row[game] = HIT;
                    hits++;
                }
            }
            return hits;
        }

        double logComplement = Math.log1p(-successRate);
        int hits = 0;
        long position = 0;
        while (true) {
            long gap = rng.geometric(logComplement);
            if (gap == Long.MAX_VALUE) return hits;
            position += gap;
            if (position > games) return hits;
            row[(int) (position - 1)] = HIT;
            hits++;
        }
    }
}
