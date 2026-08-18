package probexperiment.engine;

import probexperiment.json.JsonNode;
import probexperiment.json.JsonWriter;
import probexperiment.numeric.Histogram;
import probexperiment.numeric.Rng;
import probexperiment.numeric.Statistics;

import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.TreeSet;

/**
 * The uncertain-world mode: a three-level hierarchical model of a game you are
 * still learning to play, and whose rules you only half know.
 *
 * <p>Every parameter carries three layers of belief — a central value, an
 * uncertainty about that value, and an uncertainty about that uncertainty. The
 * outer two layers are explored by Monte Carlo. A <em>world</em> is one draw of
 * how uncertain everything is; a <em>universe</em> inside that world is one draw
 * of what the parameters actually are.
 *
 * <p>The innermost layer, the game itself, is never simulated. Within a universe
 * every parameter is fixed, so the attempt that produces the first win has a
 * closed-form distribution and the entire outcome distribution can be integrated
 * exactly in a single sweep of the horizon. That matters for honesty as much as
 * for speed: the error bars this mode reports come only from the uncertainty you
 * declared, never from how many dice the computer happened to roll.
 *
 * <p>Two consequences run through the code. Because parameters are fixed within
 * a universe, learning is a plain geometric recurrence and the inner loop needs
 * no transcendental function at all. And because each universe contributes a
 * whole distribution rather than one sample, the histograms accumulate
 * probability mass instead of counts.
 */
public final class UncertainExperiment implements Experiment {
    static final int ENTRY_COST = 0;
    static final int ATTEMPT_COST = 1;
    static final int WIN_REWARD = 2;
    static final int BASE_PROBABILITY = 3;
    static final int LEARNING_RATE = 4;
    static final int SKILL_CEILING = 5;
    static final int PARAMETER_COUNT = 6;

    private static final String[] KEYS = {
            "entryCost", "attemptCost", "winReward", "baseProbability", "learningRate", "skillCeiling"
    };
    private static final String[] LABELS = {
            "Entry cost", "Cost per attempt", "Reward per win", "Base win probability",
            "Learning rate", "Skill ceiling"
    };
    /** Which parameters are probabilities, and so are drawn from a Beta rather than a log-normal. */
    private static final boolean[] IS_PROBABILITY = {false, false, false, true, false, true};
    private static final double[] DEFAULT_MEAN = {0, 1, 100, 0.02, 0.01, 0.6};
    private static final double[] DEFAULT_UNCERTAINTY = {0.2, 0.2, 0.3, 0.5, 0.6, 0.2};
    private static final double[] DEFAULT_META = {0.3, 0.3, 0.3, 0.4, 0.5, 0.3};

    /** Resolution of the plotted curves; beyond this a chart cannot show the difference. */
    private static final int MOMENT_GRID = 256;
    /** Stopping points at which a complete outcome distribution is retained. */
    private static final int COARSE_GRID = 32;
    private static final int GRID_BINS = 512;
    private static final int FOCUS_BINS = 3_072;
    private static final int REPORTED_BINS = 320;
    private static final int SAMPLE_CAP = 8_192;
    private static final int INFORMATION_BINS = 24;

    /**
     * How the engine decides how hard to work.
     *
     * <p>The number of worlds to explore is not something a reader can sensibly
     * be asked for: it is a trade of accuracy against time, expressed in units
     * of nothing they care about. So a small pilot runs first, measures how much
     * the answer moves from world to world, and solves for the number of worlds
     * that pins the headline figure down to {@link #TARGET_RELATIVE_ERROR} of the
     * money at stake. World means are independent draws, so the error falls as
     * the square root of their count and the required number is a closed form
     * rather than a guess.
     */
    private static final int PILOT_WORLDS = 96;
    private static final int ADAPTIVE_UNIVERSES = 256;
    private static final int MAX_ADAPTIVE_WORLDS = 4_000;
    /**
     * The sampling error is judged against the spread of the outcome itself,
     * not against the size of the profit. Chasing a fixed fraction of the profit
     * is the wrong target twice over: it demands unbounded work when the profit
     * is near zero, and it keeps grinding for digits that are meaningless next
     * to an outcome that varies by hundreds either way. Holding the error to a
     * hundredth of the outcome's own standard deviation makes the Monte Carlo
     * noise negligible against the real uncertainty, which is the only
     * comparison a reader can act on.
     */
    private static final double TARGET_RELATIVE_ERROR = 0.01;
    private static final double PILOT_NOISE_HEADROOM = 1.5;
    private static final int SIZING_ROUNDS = 3;

    private static final double PROBABILITY_FLOOR = 1e-12;
    private static final double PROBABILITY_CEILING = 1 - 1e-12;
    /** Odds beyond this are indistinguishable from certainty in double precision. */
    private static final double MAX_ODDS = 1e15;
    /** Once this little chance of still playing remains, the rest of the horizon is filled analytically. */
    private static final double NEGLIGIBLE_SURVIVAL = 1e-15;

    @Override
    public String path() {
        return "uncertain";
    }

    @Override
    public String title() {
        return "Uncertain world";
    }

    private record Spec(double mean, double uncertainty, double metaUncertainty) {
        boolean certain() {
            return !(uncertainty > 0) && !(metaUncertainty > 0);
        }
    }

    /** Everything fixed for the duration of a run: inputs, grids and the work split. */
    private record Setup(
            long seed,
            int worlds,
            int universesPerWorld,
            int maxAttempts,
            boolean ceilingLaw,
            Spec[] specs,
            int[] moments,
            int[] coarse,
            int[] coarseBucket,
            int[] coarseOfMoment,
            int[] momentOfCoarse,
            int shards
    ) {
        long universeCount() {
            return (long) worlds * universesPerWorld;
        }
    }

    // --------------------------------------------------------------- request

    @Override
    public Result run(JsonNode request) throws Exception {
        long started = System.nanoTime();

        Spec[] specs = new Spec[PARAMETER_COUNT];
        for (int index = 0; index < PARAMETER_COUNT; index++) {
            JsonNode node = request.child(KEYS[index]);
            double minimumMean = IS_PROBABILITY[index] ? PROBABILITY_FLOOR : 0;
            double maximumMean = IS_PROBABILITY[index] ? PROBABILITY_CEILING : Double.MAX_VALUE;
            specs[index] = new Spec(
                    node.number("mean", DEFAULT_MEAN[index], minimumMean, maximumMean),
                    node.number("uncertainty", DEFAULT_UNCERTAINTY[index], 0, 10),
                    node.number("metaUncertainty", DEFAULT_META[index], 0, 10));
        }

        int maxAttempts = request.integer("maxAttempts", 300, 1, 5_000_000);
        boolean ceilingLaw = "ceiling".equals(request.choice("learningLaw", "logit", "logit", "ceiling"));
        long seed = request.seed("seed", new java.util.SplittableRandom().nextLong());
        // An explicit world count is honoured when given, which keeps the engine
        // driveable from a script or a test. The dashboard never sends one.
        int requestedWorlds = request.has("worlds") ? request.integer("worlds", 0, 1, 200_000) : 0;
        int universesPerWorld = request.integer("universesPerWorld", ADAPTIVE_UNIVERSES, 1, 2_000_000);

        Grids grids = new Grids(maxAttempts);
        Setup setup;
        Survey survey;
        if (requestedWorlds > 0) {
            setup = grids.setup(seed, requestedWorlds, universesPerWorld, ceilingLaw, specs);
            survey = survey(setup);
        } else {
            // Size the run from the cheap pass, then check the estimate against
            // itself. A single pilot can badly misjudge how variable the worlds
            // are; re-measuring at the larger size costs a fraction of the
            // expensive pass and stops the run finishing just short of target.
            setup = grids.setup(seed, PILOT_WORLDS, universesPerWorld, ceilingLaw, specs);
            survey = survey(setup);
            for (int round = 0; round < SIZING_ROUNDS; round++) {
                int needed = worldsForTargetPrecision(survey);
                if (needed <= setup.worlds()) break;
                setup = grids.setup(seed, needed, universesPerWorld, ceilingLaw, specs);
                survey = survey(setup);
            }
        }

        Detail detail = detail(setup, survey);

        long durationMs = Math.max(1, (System.nanoTime() - started) / 1_000_000);
        String id = Experiment.newId();
        return new Result(id, report(setup, survey, detail, id, durationMs));
    }

    /** The attempt grids, which depend only on the horizon and so survive a change of world count. */
    private static final class Grids {
        final int maxAttempts;
        final int[] moments;
        final int[] coarse;
        final int[] coarseBucket;
        final int[] coarseOfMoment;
        final int[] momentOfCoarse;

        Grids(int maxAttempts) {
            this.maxAttempts = maxAttempts;
            this.moments = buildGrid(maxAttempts, MOMENT_GRID);
            this.coarse = subsetOf(moments, COARSE_GRID);
            this.coarseBucket = bucketise(maxAttempts, coarse);
            this.coarseOfMoment = coarseOfMoment(moments, coarse);
            this.momentOfCoarse = momentOfCoarse(coarseOfMoment, coarse.length);
        }

        Setup setup(long seed, int worlds, int universesPerWorld, boolean ceilingLaw, Spec[] specs) {
            return new Setup(seed, worlds, universesPerWorld, maxAttempts, ceilingLaw, specs,
                    moments, coarse, coarseBucket, coarseOfMoment, momentOfCoarse,
                    Math.max(1, Math.min(Experiment.defaultShards(), worlds)));
        }
    }

    /**
     * How many worlds it takes to hold the headline figure steady.
     *
     * <p>The target is set against the money at stake rather than against the
     * profit itself, because a game whose expected profit is near zero would
     * otherwise demand infinite work to pin down a number that is, in the end,
     * approximately zero.
     */
    private static int worldsForTargetPrecision(Survey pilot) {
        double target = TARGET_RELATIVE_ERROR * pilot.outcomeStandardDeviation();
        if (!(pilot.betweenWorldVariance() > 0) || !(target > 0)) return PILOT_WORLDS;
        // The pilot's own variance estimate carries roughly a seventh of sampling
        // error at this many worlds, so solving for the exact count would undershoot
        // the target about half the time. The headroom costs a fraction of a second
        // and turns "close enough" into "reliably inside".
        double needed = PILOT_NOISE_HEADROOM * pilot.betweenWorldVariance() / (target * target);
        if (!Double.isFinite(needed)) return MAX_ADAPTIVE_WORLDS;
        return (int) Math.max(PILOT_WORLDS, Math.min(MAX_ADAPTIVE_WORLDS, Math.ceil(needed)));
    }

    // ------------------------------------------------------------ world plan

    /** Per-world sampling parameters, derived once so the universe loop stays pure arithmetic. */
    private static final class Plan {
        final boolean[] certain = new boolean[PARAMETER_COUNT];
        final double[] sigma = new double[PARAMETER_COUNT];
        final double[][] betaShape = new double[PARAMETER_COUNT][];
        final double[] mean = new double[PARAMETER_COUNT];

        static Plan draw(Rng rng, Spec[] specs) {
            Plan plan = new Plan();
            for (int index = 0; index < PARAMETER_COUNT; index++) {
                Spec spec = specs[index];
                plan.mean[index] = spec.mean();
                if (spec.certain() || !(spec.mean() > 0)) {
                    plan.certain[index] = true;
                    continue;
                }
                // Layer three: how uncertain this parameter is, is itself drawn.
                double cv = spec.metaUncertainty() > 0
                        ? rng.lognormal(spec.uncertainty(), spec.metaUncertainty())
                        : spec.uncertainty();
                if (!(cv > 0)) {
                    plan.certain[index] = true;
                } else if (IS_PROBABILITY[index]) {
                    double[] shape = Rng.betaShape(spec.mean(), cv);
                    if (shape == null) plan.certain[index] = true;
                    else plan.betaShape[index] = shape;
                } else {
                    plan.sigma[index] = Rng.lognormalSigma(cv);
                }
            }
            return plan;
        }

        /** Layer two: one draw of what the parameters actually are. */
        void sample(Rng rng, double[] theta) {
            for (int index = 0; index < PARAMETER_COUNT; index++) {
                if (certain[index]) {
                    theta[index] = mean[index];
                } else if (IS_PROBABILITY[index]) {
                    double[] shape = betaShape[index];
                    theta[index] = clampProbability(rng.beta(shape[0], shape[1]));
                } else {
                    theta[index] = rng.lognormalFromSigma(mean[index], sigma[index]);
                }
            }
        }
    }

    private static double clampProbability(double value) {
        if (!Double.isFinite(value)) return PROBABILITY_FLOOR;
        return Math.min(PROBABILITY_CEILING, Math.max(PROBABILITY_FLOOR, value));
    }

    // ---------------------------------------------------------------- sweep

    /**
     * Receives one universe's exact outcome as the horizon is walked.
     *
     * <p>One of these is allocated per shard, not per universe. The sweep runs
     * millions of times and anything allocated inside it would dominate the
     * cost of the arithmetic it exists to perform.
     */
    private abstract static class Sweeper {
        /** Called at each moment-grid point with the exact moments of stopping there. */
        abstract void point(int index, int attempt, double mean, double second, double winChance,
                            double spend, double marginal, double probability, double survival);

        /** Called for each attempt with the probability mass of winning exactly then. */
        void atom(int attempt, double profit, double mass) {
        }

        /** Called once the horizon is finished, so the never-won mass can be priced. */
        void finish(double entry, double cost) {
        }
    }

    /**
     * Walks one universe's horizon, reporting exact moments at every moment-grid
     * point. Nothing here is estimated: within a universe the outcome is a known
     * discrete distribution and this integrates it.
     */
    private static void sweep(Setup setup, double[] theta, Sweeper sweeper, boolean wantAtoms) {
        double entry = theta[ENTRY_COST];
        double cost = theta[ATTEMPT_COST];
        double reward = theta[WIN_REWARD];
        double base = clampProbability(theta[BASE_PROBABILITY]);
        double rate = theta[LEARNING_RATE];
        double ceiling = clampProbability(theta[SKILL_CEILING]);
        int[] moments = setup.moments();
        int attempts = setup.maxAttempts();
        boolean ceilingLaw = setup.ceilingLaw();

        // Learning as a geometric recurrence. Under the logit law the odds are
        // multiplied by a constant every attempt; under the ceiling law the
        // remaining gap to the ceiling is. Either way a single multiply replaces
        // the exponential that the closed form would otherwise need.
        double odds = base / (1 - base);
        double baseLogit = Math.log(odds);
        double growth = rate > 0 ? Math.exp(rate) : 1;
        double gap = ceiling - base;
        double decay = rate > 0 ? Math.exp(-rate) : 1;

        double survival = 1;
        double winMean = 0;
        double winSecond = 0;
        double winWait = 0;
        int cursor = 0;

        for (int attempt = 1; attempt <= attempts; attempt++) {
            double probability;
            if (ceilingLaw) {
                probability = clampProbability(ceiling - gap);
                gap *= decay;
            } else {
                if (odds > MAX_ODDS) odds = MAX_ODDS;
                probability = odds / (1 + odds);
                odds *= growth;
            }

            double reached = survival;
            double mass = survival * probability;
            survival -= mass;
            double profit = reward - entry - cost * attempt;
            winMean += mass * profit;
            winSecond += mass * profit * profit;
            winWait += mass * attempt;
            if (wantAtoms) sweeper.atom(attempt, profit, mass);

            if (cursor < moments.length && moments[cursor] == attempt) {
                double missProfit = -entry - cost * attempt;
                sweeper.point(cursor, attempt,
                        winMean + survival * missProfit,
                        winSecond + survival * missProfit * missProfit,
                        1 - survival,
                        entry + cost * (winWait + survival * attempt),
                        reached * (probability * reward - cost),
                        probability,
                        survival);
                cursor++;
            }

            if (survival < NEGLIGIBLE_SURVIVAL) {
                // What remains cannot change a result at double precision, so the rest
                // of the horizon is filled from the frozen totals in constant time.
                for (; cursor < moments.length; cursor++) {
                    int later = moments[cursor];
                    double missProfit = -entry - cost * later;
                    // The recurrence stopped early, so the learning curve has to be
                    // evaluated directly here rather than carried forward; reporting
                    // the probability from the attempt we broke out on would freeze
                    // the learning curve at whatever value it had reached.
                    sweeper.point(cursor, later,
                            winMean + survival * missProfit,
                            winSecond + survival * missProfit * missProfit,
                            1 - survival,
                            entry + cost * (winWait + survival * later),
                            0,
                            probabilityAt(later, base, baseLogit, rate, ceiling, ceilingLaw),
                            survival);
                }
                break;
            }
        }
        sweeper.finish(entry, cost);
    }

    /** The learning curve evaluated directly, for points the recurrence skipped over. */
    private static double probabilityAt(int attempt, double base, double baseLogit, double rate,
                                        double ceiling, boolean ceilingLaw) {
        if (attempt <= 1 || !(rate > 0)) return base;
        double steps = attempt - 1;
        if (ceilingLaw) return clampProbability(ceiling - (ceiling - base) * Math.exp(-rate * steps));
        double logit = baseLogit + rate * steps;
        if (logit >= 36) return PROBABILITY_CEILING;
        if (logit <= -36) return PROBABILITY_FLOOR;
        return 1 / (1 + Math.exp(-logit));
    }

    // -------------------------------------------------------------- survey

    /** First sweep: the expected-profit curve, and the range profits can occupy. */
    private record Survey(double[] expectedProfit, int bestIndex, double low, double high,
                          double betweenWorldVariance, double outcomeStandardDeviation) {
    }

    private static final class SurveySweeper extends Sweeper {
        final double[] sums;
        final double[] secondSums;
        final double[] worldSum;
        final double[] worldSumSquared;
        final double[] currentWorld;
        int worldCount;

        SurveySweeper(int grid) {
            sums = new double[grid];
            secondSums = new double[grid];
            worldSum = new double[grid];
            worldSumSquared = new double[grid];
            currentWorld = new double[grid];
        }

        @Override
        void point(int index, int attempt, double mean, double second, double winChance,
                   double spend, double marginal, double probability, double survival) {
            sums[index] += mean;
            secondSums[index] += second;
            currentWorld[index] += mean;
        }

        /** Closes a world so the spread between world means can be measured. */
        void closeWorld(int universesPerWorld) {
            for (int index = 0; index < sums.length; index++) {
                double mean = currentWorld[index] / universesPerWorld;
                worldSum[index] += mean;
                worldSumSquared[index] += mean * mean;
                currentWorld[index] = 0;
            }
            worldCount++;
        }
    }

    private static Survey survey(Setup setup) throws Exception {
        int grid = setup.moments().length;
        List<double[]> partials = Experiment.shard(setup.worlds(), shardIndex -> {
            SurveySweeper sweeper = new SurveySweeper(grid);
            Rng rng = new Rng(0);
            double[] theta = new double[PARAMETER_COUNT];
            double low = Double.POSITIVE_INFINITY;
            double high = Double.NEGATIVE_INFINITY;
            for (int world = shardIndex; world < setup.worlds(); world += setup.shards()) {
                rng.reseed(Rng.derive(setup.seed() ^ 0x5DEECE66DL, world + 1L, 0));
                Plan plan = Plan.draw(rng, setup.specs());
                for (int universe = 0; universe < setup.universesPerWorld(); universe++) {
                    rng.reseed(Rng.derive(setup.seed(), world + 1L, universe + 1L));
                    plan.sample(rng, theta);
                    low = Math.min(low, -theta[ENTRY_COST] - theta[ATTEMPT_COST] * setup.maxAttempts());
                    high = Math.max(high, theta[WIN_REWARD] - theta[ENTRY_COST] - theta[ATTEMPT_COST]);
                    sweep(setup, theta, sweeper, false);
                }
                sweeper.closeWorld(setup.universesPerWorld());
            }
            double[] result = new double[grid * 4 + 3];
            System.arraycopy(sweeper.sums, 0, result, 0, grid);
            System.arraycopy(sweeper.worldSum, 0, result, grid, grid);
            System.arraycopy(sweeper.worldSumSquared, 0, result, grid * 2, grid);
            System.arraycopy(sweeper.secondSums, 0, result, grid * 3, grid);
            result[grid * 4] = low;
            result[grid * 4 + 1] = high;
            result[grid * 4 + 2] = sweeper.worldCount;
            return result;
        }, setup.shards());

        double[] expected = new double[grid];
        double[] worldSum = new double[grid];
        double[] worldSumSquared = new double[grid];
        double[] secondSums = new double[grid];
        double low = Double.POSITIVE_INFINITY;
        double high = Double.NEGATIVE_INFINITY;
        double worldCount = 0;
        for (double[] partial : partials) {
            for (int index = 0; index < grid; index++) {
                expected[index] += partial[index];
                worldSum[index] += partial[grid + index];
                worldSumSquared[index] += partial[grid * 2 + index];
                secondSums[index] += partial[grid * 3 + index];
            }
            low = Math.min(low, partial[grid * 4]);
            high = Math.max(high, partial[grid * 4 + 1]);
            worldCount += partial[grid * 4 + 2];
        }
        double universes = setup.universeCount();
        int best = 0;
        for (int index = 0; index < grid; index++) {
            expected[index] /= universes;
            if (expected[index] > expected[best]) best = index;
        }
        double worlds = Math.max(1, worldCount);
        double worldMean = worldSum[best] / worlds;
        double betweenWorldVariance = Math.max(0, worldSumSquared[best] / worlds - worldMean * worldMean);
        double outcomeVariance = Math.max(0,
                secondSums[best] / universes - expected[best] * expected[best]);
        if (!Double.isFinite(low) || !Double.isFinite(high) || !(high > low)) {
            low = Double.isFinite(low) ? low : -1;
            high = Math.max(low + 1, Double.isFinite(high) ? high : 1);
        }
        double padding = Math.max((high - low) * 1e-6, 1e-9);
        return new Survey(expected, best, low - padding, high + padding, betweenWorldVariance,
                Math.sqrt(outcomeVariance));
    }

    // -------------------------------------------------------------- detail

    /**
     * Second sweep: everything that needed the profit range or the chosen
     * stopping point to be known first.
     *
     * <p>Two sweeps rather than one because the histograms need bin edges and
     * the focus distribution needs a stopping attempt, and both come out of the
     * first sweep. Since the sweep itself is a few arithmetic operations per
     * attempt with no memory traffic, running it twice costs far less than
     * carrying a full distribution at every candidate stopping point would.
     */
    private static final class DetailSweeper extends Sweeper {
        final Setup setup;
        final double low;
        final double high;
        final int bestAttempt;
        final int grid;
        final int coarseSize;

        final double[] sumMean;
        final double[] sumMeanSquared;
        final double[] sumSecond;
        final double[] sumWinChance;
        final double[] sumSpend;
        final double[] sumMarginal;
        final double[] sumWithinWorldVariance;
        final double[] sumWorldMean;
        final double[] sumWorldMeanSquared;
        final double[] worldMean;
        final double[] worldMeanSquared;
        final double[][] winMass;
        final double[][] missMass;
        final double[] focusWin;
        final double[] focusMiss;

        /** Per-universe scratch, reused across universes. */
        final double[] universeMean;
        final double[] universeProbability;
        final double[] coarseSurvival;
        double focusSurvival;
        int worldCount;

        DetailSweeper(Setup setup, double low, double high, int bestAttempt) {
            this.setup = setup;
            this.low = low;
            this.high = high;
            this.bestAttempt = bestAttempt;
            this.grid = setup.moments().length;
            this.coarseSize = setup.coarse().length;
            sumMean = new double[grid];
            sumMeanSquared = new double[grid];
            sumSecond = new double[grid];
            sumWinChance = new double[grid];
            sumSpend = new double[grid];
            sumMarginal = new double[grid];
            sumWithinWorldVariance = new double[grid];
            sumWorldMean = new double[grid];
            sumWorldMeanSquared = new double[grid];
            worldMean = new double[grid];
            worldMeanSquared = new double[grid];
            winMass = new double[coarseSize][GRID_BINS];
            missMass = new double[coarseSize][GRID_BINS];
            focusWin = new double[FOCUS_BINS];
            focusMiss = new double[FOCUS_BINS];
            universeMean = new double[grid];
            universeProbability = new double[grid];
            coarseSurvival = new double[coarseSize];
        }

        @Override
        void point(int index, int attempt, double mean, double second, double winChance,
                   double spend, double marginal, double probability, double survival) {
            sumMean[index] += mean;
            sumMeanSquared[index] += mean * mean;
            sumSecond[index] += second;
            sumWinChance[index] += winChance;
            sumSpend[index] += spend;
            sumMarginal[index] += marginal;
            worldMean[index] += mean;
            worldMeanSquared[index] += mean * mean;
            universeMean[index] = mean;
            universeProbability[index] = probability;
            int coarseIndex = setup.coarseOfMoment()[index];
            if (coarseIndex >= 0) coarseSurvival[coarseIndex] = survival;
            if (attempt == bestAttempt) focusSurvival = survival;
        }

        @Override
        void atom(int attempt, double profit, double mass) {
            // A win lands in the bucket of the earliest stopping rule that would
            // contain it; a prefix sum afterwards turns buckets into rules.
            winMass[setup.coarseBucket()[attempt]][Histogram.binIndex(profit, low, high, GRID_BINS)] += mass;
            if (attempt <= bestAttempt) {
                focusWin[Histogram.binIndex(profit, low, high, FOCUS_BINS)] += mass;
            }
        }

        @Override
        void finish(double entry, double cost) {
            // The mass that has not won yet is worth a different amount under each
            // stopping rule, and each rule has its own amount of it, so it must be
            // priced per rule rather than pooled at the end of the horizon.
            for (int index = 0; index < coarseSize; index++) {
                double missProfit = -entry - cost * setup.coarse()[index];
                missMass[index][Histogram.binIndex(missProfit, low, high, GRID_BINS)] += coarseSurvival[index];
            }
            double focusProfit = -entry - cost * bestAttempt;
            focusMiss[Histogram.binIndex(focusProfit, low, high, FOCUS_BINS)] += focusSurvival;
        }

        void closeWorld(int universesPerWorld) {
            for (int index = 0; index < grid; index++) {
                double mean = worldMean[index] / universesPerWorld;
                sumWorldMean[index] += mean;
                sumWorldMeanSquared[index] += mean * mean;
                sumWithinWorldVariance[index] +=
                        Math.max(0, worldMeanSquared[index] / universesPerWorld - mean * mean);
            }
            Arrays.fill(worldMean, 0);
            Arrays.fill(worldMeanSquared, 0);
            worldCount++;
        }

        void absorb(DetailSweeper other) {
            for (int index = 0; index < grid; index++) {
                sumMean[index] += other.sumMean[index];
                sumMeanSquared[index] += other.sumMeanSquared[index];
                sumSecond[index] += other.sumSecond[index];
                sumWinChance[index] += other.sumWinChance[index];
                sumSpend[index] += other.sumSpend[index];
                sumMarginal[index] += other.sumMarginal[index];
                sumWithinWorldVariance[index] += other.sumWithinWorldVariance[index];
                sumWorldMean[index] += other.sumWorldMean[index];
                sumWorldMeanSquared[index] += other.sumWorldMeanSquared[index];
            }
            for (int index = 0; index < coarseSize; index++) {
                for (int bin = 0; bin < GRID_BINS; bin++) {
                    winMass[index][bin] += other.winMass[index][bin];
                    missMass[index][bin] += other.missMass[index][bin];
                }
            }
            for (int bin = 0; bin < FOCUS_BINS; bin++) {
                focusWin[bin] += other.focusWin[bin];
                focusMiss[bin] += other.focusMiss[bin];
            }
            worldCount += other.worldCount;
        }
    }

    /** The finished aggregates the report is rendered from. */
    private record Detail(
            double[] expectedProfit,
            double[] expectedSpend,
            double[] winChance,
            double[] marginal,
            double[] varianceLuck,
            double[] varianceParameter,
            double[] varianceHyper,
            Histogram[] coarseHistogram,
            Histogram focus,
            double[][] sampleTheta,
            double[][] sampleCurve,
            double[][] sampleProbability,
            int bestAttempt,
            double standardError
    ) {
    }

    private static Detail detail(Setup setup, Survey survey) throws Exception {
        int grid = setup.moments().length;
        int coarseSize = setup.coarse().length;
        double low = survey.low();
        double high = survey.high();
        int bestAttempt = setup.moments()[survey.bestIndex()];

        long universeCount = setup.universeCount();
        int stride = (int) Math.max(1, (universeCount + SAMPLE_CAP - 1) / SAMPLE_CAP);
        int slots = (int) Math.min(SAMPLE_CAP, (universeCount + stride - 1) / stride);
        double[][] sampleTheta = new double[slots][];
        double[][] sampleCurve = new double[slots][];
        double[][] sampleProbability = new double[slots][];

        List<DetailSweeper> shards = Experiment.shard(setup.worlds(), shardIndex -> {
            DetailSweeper sweeper = new DetailSweeper(setup, low, high, bestAttempt);
            Rng rng = new Rng(0);
            double[] theta = new double[PARAMETER_COUNT];
            for (int world = shardIndex; world < setup.worlds(); world += setup.shards()) {
                rng.reseed(Rng.derive(setup.seed() ^ 0x5DEECE66DL, world + 1L, 0));
                Plan plan = Plan.draw(rng, setup.specs());
                for (int universe = 0; universe < setup.universesPerWorld(); universe++) {
                    rng.reseed(Rng.derive(setup.seed(), world + 1L, universe + 1L));
                    plan.sample(rng, theta);
                    sweep(setup, theta, sweeper, true);

                    long globalIndex = (long) world * setup.universesPerWorld() + universe;
                    if (globalIndex % stride != 0) continue;
                    int slot = (int) (globalIndex / stride);
                    if (slot >= slots) continue;
                    double[] curve = new double[coarseSize];
                    double[] chance = new double[coarseSize];
                    for (int index = 0; index < coarseSize; index++) {
                        int position = setup.momentOfCoarse()[index];
                        curve[index] = sweeper.universeMean[position];
                        chance[index] = sweeper.universeProbability[position];
                    }
                    sampleTheta[slot] = theta.clone();
                    sampleCurve[slot] = curve;
                    sampleProbability[slot] = chance;
                }
                sweeper.closeWorld(setup.universesPerWorld());
            }
            return sweeper;
        }, setup.shards());

        DetailSweeper merged = new DetailSweeper(setup, low, high, bestAttempt);
        for (DetailSweeper shard : shards) merged.absorb(shard);

        double universes = universeCount;
        double worlds = Math.max(1, merged.worldCount);
        double standardError = Double.NaN;
        double[] expectedProfit = new double[grid];
        double[] expectedSpend = new double[grid];
        double[] winChance = new double[grid];
        double[] marginal = new double[grid];
        double[] varianceLuck = new double[grid];
        double[] varianceParameter = new double[grid];
        double[] varianceHyper = new double[grid];
        for (int index = 0; index < grid; index++) {
            expectedProfit[index] = merged.sumMean[index] / universes;
            expectedSpend[index] = merged.sumSpend[index] / universes;
            winChance[index] = merged.sumWinChance[index] / universes;
            marginal[index] = merged.sumMarginal[index] / universes;
            // The law of total variance, applied across all three layers.
            // Luck is the spread that remains once the parameters are known;
            // the other two are the spread created by not knowing the
            // parameters, and by not knowing how badly you know them.
            varianceLuck[index] = Math.max(0,
                    (merged.sumSecond[index] - merged.sumMeanSquared[index]) / universes);
            varianceParameter[index] = merged.sumWithinWorldVariance[index] / worlds;
            double worldMean = merged.sumWorldMean[index] / worlds;
            // The spread between world means is inflated by the fact that each
            // world mean is itself estimated from finitely many universes.
            // Subtracting that sampling term leaves the meta-uncertainty alone,
            // so declaring no meta-uncertainty reports none rather than a
            // residue that shrinks only as the run gets longer.
            double betweenWorlds = Math.max(0,
                    merged.sumWorldMeanSquared[index] / worlds - worldMean * worldMean);
            varianceHyper[index] = Math.max(0,
                    betweenWorlds - varianceParameter[index] / setup.universesPerWorld());
            if (index == survey.bestIndex()) standardError = Math.sqrt(betweenWorlds / worlds);
        }

        for (int index = 1; index < coarseSize; index++) {
            for (int bin = 0; bin < GRID_BINS; bin++) {
                merged.winMass[index][bin] += merged.winMass[index - 1][bin];
            }
        }
        Histogram[] coarseHistogram = new Histogram[coarseSize];
        double[] combined = new double[GRID_BINS];
        for (int index = 0; index < coarseSize; index++) {
            for (int bin = 0; bin < GRID_BINS; bin++) {
                combined[bin] = merged.winMass[index][bin] + merged.missMass[index][bin];
            }
            coarseHistogram[index] = new Histogram(low, high, GRID_BINS);
            coarseHistogram[index].load(combined);
        }
        Histogram focus = new Histogram(low, high, FOCUS_BINS);
        double[] focusCombined = new double[FOCUS_BINS];
        for (int bin = 0; bin < FOCUS_BINS; bin++) {
            focusCombined[bin] = merged.focusWin[bin] + merged.focusMiss[bin];
        }
        focus.load(focusCombined);

        int filled = 0;
        for (double[] entry : sampleTheta) if (entry != null) filled++;
        return new Detail(expectedProfit, expectedSpend, winChance, marginal,
                varianceLuck, varianceParameter, varianceHyper, coarseHistogram, focus,
                compact(sampleTheta, filled), compact(sampleCurve, filled),
                compact(sampleProbability, filled), bestAttempt, standardError);
    }

    private static double[][] compact(double[][] source, int filled) {
        double[][] target = new double[filled][];
        int cursor = 0;
        for (double[] entry : source) if (entry != null) target[cursor++] = entry;
        return target;
    }

    // ---------------------------------------------------------------- grids

    private static int[] buildGrid(int maxAttempts, int target) {
        TreeSet<Integer> values = new TreeSet<>();
        values.add(1);
        values.add(maxAttempts);
        int points = Math.min(target, maxAttempts);
        for (int index = 0; index < points; index++) {
            double ratio = points == 1 ? 1 : index / (double) (points - 1);
            // Logarithmic spacing: the interesting behaviour is concentrated in the
            // first handful of attempts, and a linear grid would step straight over it.
            int value = (int) Math.round(Math.exp(Math.log(maxAttempts) * ratio));
            values.add(Math.max(1, Math.min(maxAttempts, value)));
        }
        int[] grid = new int[values.size()];
        int cursor = 0;
        for (int value : values) grid[cursor++] = value;
        return grid;
    }

    /** Evenly spaced subset, so every coarse point is also a moment point. */
    private static int[] subsetOf(int[] grid, int target) {
        if (grid.length <= target) return grid.clone();
        TreeSet<Integer> values = new TreeSet<>();
        for (int index = 0; index < target; index++) {
            values.add(grid[(int) ((long) index * (grid.length - 1) / (target - 1))]);
        }
        int[] subset = new int[values.size()];
        int cursor = 0;
        for (int value : values) subset[cursor++] = value;
        return subset;
    }

    /** For each attempt, the earliest coarse stopping rule that would contain a win there. */
    private static int[] bucketise(int maxAttempts, int[] coarse) {
        int[] bucket = new int[maxAttempts + 1];
        int cursor = 0;
        for (int attempt = 1; attempt <= maxAttempts; attempt++) {
            while (cursor < coarse.length - 1 && coarse[cursor] < attempt) cursor++;
            bucket[attempt] = cursor;
        }
        return bucket;
    }

    /** Moment-grid position of each coarse point, the reverse of {@link #coarseOfMoment}. */
    private static int[] momentOfCoarse(int[] coarseOfMoment, int coarseSize) {
        int[] mapping = new int[coarseSize];
        for (int index = 0; index < coarseOfMoment.length; index++) {
            if (coarseOfMoment[index] >= 0) mapping[coarseOfMoment[index]] = index;
        }
        return mapping;
    }

    /** Coarse index of each moment-grid position, or -1 where the two do not coincide. */
    private static int[] coarseOfMoment(int[] moments, int[] coarse) {
        int[] mapping = new int[moments.length];
        Arrays.fill(mapping, -1);
        int cursor = 0;
        for (int index = 0; index < moments.length && cursor < coarse.length; index++) {
            if (moments[index] == coarse[cursor]) mapping[index] = cursor++;
        }
        return mapping;
    }

    // ---------------------------------------------------------------- report

    private static String report(Setup setup, Survey survey, Detail detail, String id, long durationMs) {
        int grid = setup.moments().length;
        int coarseSize = setup.coarse().length;
        int bestIndex = survey.bestIndex();

        double[] stdDev = new double[grid];
        for (int index = 0; index < grid; index++) {
            stdDev[index] = Math.sqrt(Math.max(0, detail.varianceLuck()[index]
                    + detail.varianceParameter()[index] + detail.varianceHyper()[index]));
        }

        double[] p05 = new double[coarseSize];
        double[] p25 = new double[coarseSize];
        double[] p50 = new double[coarseSize];
        double[] p75 = new double[coarseSize];
        double[] p95 = new double[coarseSize];
        double[] profitChance = new double[coarseSize];
        for (int index = 0; index < coarseSize; index++) {
            Histogram histogram = detail.coarseHistogram()[index];
            p05[index] = histogram.quantile(.05);
            p25[index] = histogram.quantile(.25);
            p50[index] = histogram.quantile(.50);
            p75[index] = histogram.quantile(.75);
            p95[index] = histogram.quantile(.95);
            profitChance[index] = histogram.total() > 0 ? histogram.massAbove(0) / histogram.total() : 0;
        }

        double[][] fan = fan(detail.sampleProbability(), coarseSize);
        Analysis analysis = analyse(detail, setup.coarse());

        JsonWriter json = new JsonWriter(48_000 + grid * 96);
        json.beginObject()
                .field("id", id)
                .field("createdAt", Instant.now().toString())
                .field("seed", setup.seed())
                .field("durationMs", durationMs)
                .field("worlds", (long) setup.worlds())
                .field("universesPerWorld", (long) setup.universesPerWorld())
                .field("universeCount", setup.universeCount())
                .field("maxAttempts", (long) setup.maxAttempts())
                .field("learningLaw", setup.ceilingLaw() ? "ceiling" : "logit")
                .field("sampleSize", (long) detail.sampleTheta().length);

        json.beginObject("inputs");
        for (int index = 0; index < PARAMETER_COUNT; index++) {
            Spec spec = setup.specs()[index];
            json.beginObject(KEYS[index])
                    .field("mean", spec.mean())
                    .field("uncertainty", spec.uncertainty())
                    .field("metaUncertainty", spec.metaUncertainty())
                    .endObject();
        }
        json.endObject();

        json.series("attempts", setup.moments())
                .series("expectedProfit", detail.expectedProfit())
                .series("profitStdDev", stdDev)
                .series("winChance", detail.winChance())
                .series("expectedSpend", detail.expectedSpend())
                .series("marginalValue", detail.marginal())
                .series("varianceLuck", detail.varianceLuck())
                .series("varianceParameter", detail.varianceParameter())
                .series("varianceHyper", detail.varianceHyper())
                .series("coarseAttempts", setup.coarse())
                .series("profitP05", p05)
                .series("profitP25", p25)
                .series("profitP50", p50)
                .series("profitP75", p75)
                .series("profitP95", p95)
                .series("profitChance", profitChance)
                .series("probabilityP05", fan[0])
                .series("probabilityP25", fan[1])
                .series("probabilityP50", fan[2])
                .series("probabilityP75", fan[3])
                .series("probabilityP95", fan[4]);

        Histogram focus = detail.focus();
        json.beginObject("profitHistogram")
                .field("low", focus.low())
                .field("high", focus.high())
                .field("attempts", (long) detail.bestAttempt())
                .series("density", focus.density(REPORTED_BINS))
                .endObject();

        double expectedProfit = detail.expectedProfit()[bestIndex];
        double expectedSpend = detail.expectedSpend()[bestIndex];
        json.beginObject("optimal")
                .field("attempts", (long) detail.bestAttempt())
                .field("expectedProfit", expectedProfit)
                .field("expectedSpend", expectedSpend)
                .field("roiPercent", expectedSpend > 0 ? expectedProfit / expectedSpend * 100 : Double.NaN)
                .field("winChance", detail.winChance()[bestIndex])
                .field("profitChance", focus.total() > 0 ? focus.massAbove(0) / focus.total() : 0)
                .field("profitP05", focus.quantile(.05))
                .field("profitP50", focus.quantile(.50))
                .field("profitP95", focus.quantile(.95))
                .field("conditionalValueAtRisk05", focus.tailMean(.05))
                .field("standardDeviation", stdDev[bestIndex])
                .field("varianceLuck", detail.varianceLuck()[bestIndex])
                .field("varianceParameter", detail.varianceParameter()[bestIndex])
                .field("varianceHyper", detail.varianceHyper()[bestIndex])
                .field("varianceTotal", detail.varianceLuck()[bestIndex]
                        + detail.varianceParameter()[bestIndex] + detail.varianceHyper()[bestIndex])
                .field("marginalValue", detail.marginal()[bestIndex])
                .endObject();

        json.beginArray("sensitivity");
        for (int index = 0; index < PARAMETER_COUNT; index++) {
            json.beginObject()
                    .field("key", KEYS[index])
                    .field("label", LABELS[index])
                    .field("spearman", analysis.spearman()[index])
                    .field("standardisedBeta", analysis.beta()[index])
                    .field("share", analysis.share()[index])
                    .endObject();
        }
        json.endArray().field("rankRSquared", analysis.rankRSquared());

        json.beginObject("valueOfInformation")
                .field("perfect", analysis.perfect())
                .beginArray("parameters");
        for (int index = 0; index < PARAMETER_COUNT; index++) {
            json.beginObject()
                    .field("key", KEYS[index])
                    .field("label", LABELS[index])
                    .field("value", analysis.partial()[index])
                    .endObject();
        }
        json.endArray().endObject();

        double cost = setup.specs()[ATTEMPT_COST].mean();
        double reward = setup.specs()[WIN_REWARD].mean();
        double spread = stdDev[bestIndex];
        json.beginObject("precision")
                .field("standardError", detail.standardError())
                .field("outcomeStandardDeviation", spread)
                .field("relativeError", spread > 0 ? detail.standardError() / spread : Double.NaN)
                .field("target", TARGET_RELATIVE_ERROR)
                .field("converged", Double.isFinite(detail.standardError())
                        && detail.standardError() <= TARGET_RELATIVE_ERROR * spread)
                .field("worlds", (long) setup.worlds())
                .field("universesPerWorld", (long) setup.universesPerWorld())
                .endObject();

        json.beginObject("reference")
                .field("breakEvenProbability", reward > 0 ? cost / reward : Double.NaN)
                .field("meanBaseProbability", setup.specs()[BASE_PROBABILITY].mean())
                .field("finalProbabilityP50", fan[2][coarseSize - 1])
                .endObject();

        return json.endObject().toString();
    }

    private static double[][] fan(double[][] sampleProbability, int coarseSize) {
        double[][] fan = new double[5][coarseSize];
        int count = sampleProbability.length;
        if (count == 0) return fan;
        double[] column = new double[count];
        double[] levels = {.05, .25, .5, .75, .95};
        for (int position = 0; position < coarseSize; position++) {
            for (int index = 0; index < count; index++) column[index] = sampleProbability[index][position];
            Arrays.sort(column);
            for (int level = 0; level < levels.length; level++) {
                fan[level][position] = Statistics.sortedQuantile(column, count, levels[level]);
            }
        }
        return fan;
    }

    // ----------------------------------------------------- sensitivity, value

    private record Analysis(double[] spearman, double[] beta, double[] share, double rankRSquared,
                            double perfect, double[] partial) {
    }

    /**
     * Which uncertainty is actually driving the outcome, and what removing it
     * would be worth.
     *
     * <p>Both questions are answered on ranks rather than raw values, because
     * every relationship here is monotone but strongly curved — a log-normal
     * cost feeding a geometric waiting time feeding a profit. An ordinary
     * correlation would understate a parameter that dominates the result simply
     * because it dominates it along a curve.
     */
    private static Analysis analyse(Detail detail, int[] coarse) {
        double[] spearman = new double[PARAMETER_COUNT];
        double[] beta = new double[PARAMETER_COUNT];
        double[] share = new double[PARAMETER_COUNT];
        double[] partial = new double[PARAMETER_COUNT];
        int count = detail.sampleTheta().length;
        int coarseSize = coarse.length;
        if (count < 16) return new Analysis(spearman, beta, share, 0, 0, partial);

        int bestIndex = nearest(coarse, detail.bestAttempt());
        double[] outcome = new double[count];
        for (int index = 0; index < count; index++) outcome[index] = detail.sampleCurve()[index][bestIndex];
        double[] outcomeRank = Statistics.ranks(outcome, count);
        Statistics.standardise(outcomeRank, count);

        double[][] predictor = new double[PARAMETER_COUNT][];
        double[] column = new double[count];
        for (int parameter = 0; parameter < PARAMETER_COUNT; parameter++) {
            for (int index = 0; index < count; index++) column[index] = detail.sampleTheta()[index][parameter];
            predictor[parameter] = Statistics.ranks(column, count);
            Statistics.standardise(predictor[parameter], count);
            double covariance = 0;
            for (int index = 0; index < count; index++) {
                covariance += predictor[parameter][index] * outcomeRank[index];
            }
            spearman[parameter] = covariance / count;
        }

        double[][] normal = new double[PARAMETER_COUNT][PARAMETER_COUNT];
        for (int row = 0; row < PARAMETER_COUNT; row++) {
            for (int col = row; col < PARAMETER_COUNT; col++) {
                double total = 0;
                for (int index = 0; index < count; index++) {
                    total += predictor[row][index] * predictor[col][index];
                }
                normal[row][col] = total / count;
                normal[col][row] = normal[row][col];
            }
        }
        beta = Statistics.solve(normal, spearman.clone());
        double explained = 0;
        double magnitude = 0;
        for (int parameter = 0; parameter < PARAMETER_COUNT; parameter++) {
            explained += beta[parameter] * spearman[parameter];
            magnitude += beta[parameter] * beta[parameter];
        }
        for (int parameter = 0; parameter < PARAMETER_COUNT; parameter++) {
            share[parameter] = magnitude > 0 ? beta[parameter] * beta[parameter] / magnitude : 0;
        }

        // Value of information. The baseline is the best single stopping rule you
        // can choose knowing only what you know today. Perfect information would
        // let you choose the best rule for each universe separately, and the gap
        // between the two is what resolving the uncertainty is worth.
        double[] average = new double[coarseSize];
        for (int index = 0; index < count; index++) {
            for (int position = 0; position < coarseSize; position++) {
                average[position] += detail.sampleCurve()[index][position];
            }
        }
        double baseline = Double.NEGATIVE_INFINITY;
        for (int position = 0; position < coarseSize; position++) {
            baseline = Math.max(baseline, average[position] / count);
        }
        double perfectTotal = 0;
        for (int index = 0; index < count; index++) {
            double best = Double.NEGATIVE_INFINITY;
            for (int position = 0; position < coarseSize; position++) {
                best = Math.max(best, detail.sampleCurve()[index][position]);
            }
            perfectTotal += best;
        }
        double perfect = Math.max(0, perfectTotal / count - baseline);

        // Partial information: learning one parameter exactly. Universes are grouped
        // by that parameter's value, the best rule is chosen for each group, and the
        // improvement over the single baseline rule is what that one answer buys.
        int bins = Math.max(2, Math.min(INFORMATION_BINS, count / 16));
        double[] curve = new double[coarseSize];
        for (int parameter = 0; parameter < PARAMETER_COUNT; parameter++) {
            for (int index = 0; index < count; index++) column[index] = detail.sampleTheta()[index][parameter];
            int[] order = Statistics.order(column, count);
            double total = 0;
            for (int bin = 0; bin < bins; bin++) {
                int from = (int) ((long) bin * count / bins);
                int to = (int) ((long) (bin + 1) * count / bins);
                if (to <= from) continue;
                Arrays.fill(curve, 0);
                for (int index = from; index < to; index++) {
                    double[] row = detail.sampleCurve()[order[index]];
                    for (int position = 0; position < coarseSize; position++) curve[position] += row[position];
                }
                double best = Double.NEGATIVE_INFINITY;
                for (int position = 0; position < coarseSize; position++) {
                    best = Math.max(best, curve[position] / (to - from));
                }
                total += best * (to - from);
            }
            partial[parameter] = Math.max(0, total / count - baseline);
        }
        return new Analysis(spearman, beta, share, Math.max(0, Math.min(1, explained)), perfect, partial);
    }

    private static int nearest(int[] grid, int wanted) {
        int best = 0;
        for (int index = 1; index < grid.length; index++) {
            if (Math.abs(grid[index] - wanted) < Math.abs(grid[best] - wanted)) best = index;
        }
        return best;
    }
}
