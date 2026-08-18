package probexperiment.engine;

import probexperiment.json.JsonNode;
import probexperiment.json.JsonWriter;
import probexperiment.numeric.Rng;

import java.math.BigInteger;
import java.time.Instant;
import java.util.List;

/**
 * The unknown-odds mode: the same experiment repeated across 1,089
 * probabilities, from 0.01% in hundredth-of-a-percent steps to 1%, then in
 * tenth-of-a-percent steps to 99.9%.
 *
 * <p>Nothing here is approximated, but nothing is flipped one coin at a time
 * either. For an agent playing {@code n} independent games at probability
 * {@code p}, the trial of the first win is geometric, and — because the trials
 * are independent — conditioning on that trial leaves the remaining
 * {@code n - first} games as untouched Bernoulli trials. So the pair
 * (first win, total wins) can be drawn as one geometric plus one binomial and
 * has exactly the joint distribution of playing the games out. That turns the
 * cost of a probability point from {@code agents × games} into {@code agents},
 * which is why the number of games per agent no longer affects how long a sweep
 * takes.
 */
public final class SweepExperiment implements Experiment {
    private static final int DEFAULT_AGENTS = 200;
    private static final int DEFAULT_GAMES = 300;
    private static final double MOVE_ON_CONFIDENCE = 0.9;

    @Override
    public String path() {
        return "sweeps";
    }

    @Override
    public String title() {
        return "Unknown odds";
    }

    /** The probability ladder, in hundredths of a percent. */
    private static int[] ladder() {
        int[] steps = new int[1_089];
        int cursor = 0;
        for (int hundredths = 1; hundredths <= 100; hundredths++) steps[cursor++] = hundredths;
        for (int hundredths = 110; hundredths <= 9_990; hundredths += 10) steps[cursor++] = hundredths;
        return steps;
    }

    private record Point(
            int probabilityHundredths,
            long totalSuccesses,
            int agentsWithSuccess,
            int agentsWithoutSuccess,
            double averageSuccessesPerAgent,
            double successStdDev,
            double averageFirstSuccess,
            int medianFirstSuccess,
            int p90FirstSuccess,
            int[] firstSuccessCounts
    ) {
    }

    @Override
    public Result run(JsonNode request) throws Exception {
        int agentCount = request.integer("agentCount", DEFAULT_AGENTS, 1, Integer.MAX_VALUE);
        int gamesPerAgent = request.integer("gamesPerAgent", DEFAULT_GAMES, 1, Integer.MAX_VALUE);
        double gameCost = request.number("gameCost", 1.0, 0, Double.MAX_VALUE);
        double winReward = request.number("winReward", 100.0, 0, Double.MAX_VALUE);
        long seed = request.seed("seed", new java.util.SplittableRandom().nextLong());

        long started = System.nanoTime();
        int[] ladder = ladder();
        Point[] points = new Point[ladder.length];
        final int shards = Math.max(1, Math.min(Experiment.defaultShards(), ladder.length));

        Experiment.shard(ladder.length, shard -> {
            Rng rng = new Rng(0);
            for (int index = shard; index < ladder.length; index += shards) {
                points[index] = measure(rng, seed, ladder[index], agentCount, gamesPerAgent);
            }
            return shard;
        }, shards);

        long durationMs = Math.max(1, (System.nanoTime() - started) / 1_000_000);
        String id = Experiment.newId();

        Double firstWinningProbabilityPercent = null;
        Integer recommendedAttempts90 = null;
        for (int hundredths : ladder) {
            double probability = hundredths / 10_000.0;
            if (probability * winReward - gameCost > 1e-12) {
                firstWinningProbabilityPercent = hundredths / 100.0;
                recommendedAttempts90 = Math.max(1,
                        (int) Math.ceil(Math.log1p(-MOVE_ON_CONFIDENCE) / Math.log1p(-probability)));
                break;
            }
        }

        BigInteger totalGames = BigInteger.valueOf(ladder.length)
                .multiply(BigInteger.valueOf(agentCount))
                .multiply(BigInteger.valueOf(gamesPerAgent));

        long estimate = 4_096L + (long) ladder.length * (320L + gamesPerAgent * 4L);
        JsonWriter json = new JsonWriter((int) Math.min(Integer.MAX_VALUE - 32, estimate));
        json.beginObject()
                .field("id", id)
                .field("createdAt", Instant.now().toString())
                .field("seed", seed)
                .field("durationMs", durationMs)
                .field("agentCount", (long) agentCount)
                .field("gamesPerAgent", (long) gamesPerAgent)
                .field("gameCost", gameCost)
                .field("winReward", winReward)
                .field("probabilityCount", (long) ladder.length)
                .name("totalGames").raw(totalGames.toString())
                .name("breakEvenProbabilityPercent");
        if (winReward > 0) json.value(gameCost / winReward * 100);
        else if (gameCost == 0) json.value(0L);
        else json.nullValue();
        json.name("firstWinningProbabilityPercent");
        if (firstWinningProbabilityPercent == null) json.nullValue();
        else json.value((double) firstWinningProbabilityPercent);
        json.name("recommendedAttempts90");
        if (recommendedAttempts90 == null) json.nullValue();
        else json.value((long) recommendedAttempts90);

        json.beginArray("points");
        long gamesTotalPerPoint = (long) agentCount * gamesPerAgent;
        for (Point point : points) {
            long failures = gamesTotalPerPoint - point.totalSuccesses();
            double actualRate = point.totalSuccesses() / (double) gamesTotalPerPoint;
            double observedNet = point.totalSuccesses() * winReward - gamesTotalPerPoint * gameCost;
            json.beginObject()
                    .field("probabilityPercent", point.probabilityHundredths() / 100.0)
                    .field("probability", point.probabilityHundredths() / 10_000.0)
                    .field("totalSuccesses", point.totalSuccesses())
                    .field("totalFailures", failures)
                    .field("actualRate", actualRate)
                    .field("agentsWithSuccess", (long) point.agentsWithSuccess())
                    .field("agentsWithoutSuccess", (long) point.agentsWithoutSuccess())
                    .field("averageSuccessesPerAgent", point.averageSuccessesPerAgent())
                    .field("successStdDev", point.successStdDev())
                    .field("averageFirstSuccess", point.averageFirstSuccess())
                    .field("medianFirstSuccess", (long) point.medianFirstSuccess())
                    .field("p90FirstSuccess", (long) point.p90FirstSuccess())
                    .field("observedNet", observedNet)
                    .series("firstSuccessCounts", point.firstSuccessCounts())
                    .endObject();
        }
        json.endArray().endObject();
        return new Result(id, json.toString());
    }

    private static Point measure(Rng rng, long seed, int hundredths, int agentCount, int gamesPerAgent) {
        double probability = hundredths / 10_000.0;
        double logComplement = Math.log1p(-probability);
        int[] firstSuccessCounts = new int[gamesPerAgent];
        long totalSuccesses = 0;
        double successSquares = 0;
        int agentsWithSuccess = 0;
        long firstSuccessSum = 0;

        for (int agent = 0; agent < agentCount; agent++) {
            rng.reseed(Rng.derive(seed, hundredths, agent + 1L));
            long firstWin = probability >= 1 ? 1 : rng.geometric(logComplement);
            int successes = 0;
            if (firstWin <= gamesPerAgent) {
                int remaining = gamesPerAgent - (int) firstWin;
                successes = 1 + (remaining > 0 ? rng.binomial(remaining, probability) : 0);
                agentsWithSuccess++;
                firstSuccessCounts[(int) firstWin - 1]++;
                firstSuccessSum += firstWin;
            }
            totalSuccesses += successes;
            successSquares += (double) successes * successes;
        }

        int agentsWithoutSuccess = agentCount - agentsWithSuccess;
        double averageSuccesses = totalSuccesses / (double) agentCount;
        double variance = Math.max(0, successSquares / agentCount - averageSuccesses * averageSuccesses);
        double averageFirstSuccess = agentsWithSuccess == 0 ? 0 : firstSuccessSum / (double) agentsWithSuccess;
        int median = waitPercentile(firstSuccessCounts, agentsWithoutSuccess, agentCount, .5, gamesPerAgent);
        int p90 = waitPercentile(firstSuccessCounts, agentsWithoutSuccess, agentCount, .9, gamesPerAgent);
        return new Point(hundredths, totalSuccesses, agentsWithSuccess, agentsWithoutSuccess,
                averageSuccesses, Math.sqrt(variance), averageFirstSuccess, median, p90, firstSuccessCounts);
    }

    /**
     * The game by which the given share of agents had seen a first win. Agents
     * that never won push the answer past the limit rather than being dropped,
     * because excluding them would report a shorter wait than anyone
     * experienced.
     */
    private static int waitPercentile(int[] firstSuccessCounts, int agentsWithoutSuccess,
                                      int agentCount, double percentile, int gamesPerAgent) {
        int target = Math.max(1, (int) Math.ceil(agentCount * percentile));
        int cumulative = 0;
        for (int game = 0; game < firstSuccessCounts.length; game++) {
            cumulative += firstSuccessCounts[game];
            if (cumulative >= target) return game + 1;
        }
        return agentsWithoutSuccess > 0 ? gamesPerAgent + 1 : gamesPerAgent;
    }
}
