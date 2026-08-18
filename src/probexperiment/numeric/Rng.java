package probexperiment.numeric;

/**
 * A reseedable SplitMix64 generator carrying the sampling distributions this
 * project needs.
 *
 * <p>Every distribution here is exact. Nothing is a normal approximation of the
 * thing it is named after, because the experiments built on top of it are read
 * as statements about tails and rare events, which is precisely where
 * approximations stop telling the truth.
 *
 * <p>Instances are deliberately mutable and cheap to reseed so a worker can
 * hold one generator for the length of a task instead of allocating per draw.
 * They are not thread safe; give every thread its own.
 */
public final class Rng {
    private static final double UNIT = 0x1.0p-53;
    private static final long GOLDEN = 0x9E3779B97F4A7C15L;
    private static final long SECOND_GOLDEN = 0xC2B2AE3D27D4EB4FL;

    /** Beyond this many trials the beta-splitting binomial beats counting successes. */
    private static final int SPLIT_TRIALS = 48;
    private static final double SPLIT_EXPECTED_SUCCESSES = 24;

    private long state;
    private double spareGaussian;
    private boolean hasSpareGaussian;

    public Rng(long seed) {
        reseed(seed);
    }

    /** Restarts the stream. Any half-used Gaussian pair is discarded so the stream stays a pure function of the seed. */
    public void reseed(long seed) {
        state = seed;
        hasSpareGaussian = false;
    }

    /**
     * Deterministic stream separation. Distinct {@code (seed, first, second)}
     * triples give distinct streams, so a parallel run reproduces exactly
     * regardless of how the work was scheduled across threads.
     */
    public static long derive(long seed, long first, long second) {
        return finalise(seed ^ (first * GOLDEN) ^ (second * SECOND_GOLDEN));
    }

    private static long finalise(long value) {
        value = (value ^ (value >>> 30)) * 0xBF58476D1CE4E5B9L;
        value = (value ^ (value >>> 27)) * 0x94D049BB133111EBL;
        return value ^ (value >>> 31);
    }

    public long nextLong() {
        return finalise(state += GOLDEN);
    }

    /** Uniform on [0, 1). */
    public double nextDouble() {
        return (nextLong() >>> 11) * UNIT;
    }

    /** Uniform on (0, 1]. Safe to pass to {@link Math#log}, which the waiting-time samplers rely on. */
    public double nextOpenDouble() {
        return ((nextLong() >>> 11) + 1) * UNIT;
    }

    /** Standard normal by Marsaglia's polar method, which needs no trigonometry. */
    public double nextGaussian() {
        if (hasSpareGaussian) {
            hasSpareGaussian = false;
            return spareGaussian;
        }
        double first;
        double second;
        double radius;
        do {
            first = 2 * nextDouble() - 1;
            second = 2 * nextDouble() - 1;
            radius = first * first + second * second;
        } while (radius >= 1 || radius == 0);
        double scale = Math.sqrt(-2 * Math.log(radius) / radius);
        spareGaussian = second * scale;
        hasSpareGaussian = true;
        return first * scale;
    }

    // ------------------------------------------------------------- continuous

    /**
     * Log-normal draw with exact mean {@code mean} and exact coefficient of
     * variation {@code cv}. Callers in a hot loop should hoist
     * {@link #lognormalSigma} and use {@link #lognormalFromSigma} instead.
     */
    public double lognormal(double mean, double cv) {
        if (!(mean > 0)) return 0;
        if (!(cv > 0)) return mean;
        return lognormalFromSigma(mean, lognormalSigma(cv));
    }

    /** The log-scale sigma that produces a coefficient of variation of {@code cv}. */
    public static double lognormalSigma(double cv) {
        return cv > 0 ? Math.sqrt(Math.log1p(cv * cv)) : 0;
    }

    /** Log-normal with mean {@code mean}, given a precomputed log-scale sigma. */
    public double lognormalFromSigma(double mean, double sigma) {
        if (!(mean > 0)) return 0;
        if (!(sigma > 0)) return mean;
        return mean * Math.exp(sigma * nextGaussian() - sigma * sigma / 2);
    }

    /** Gamma(shape, 1) by Marsaglia and Tsang's squeeze method. */
    public double gamma(double shape) {
        if (!(shape > 0)) return 0;
        if (shape < 1) {
            return gamma(shape + 1) * Math.pow(nextOpenDouble(), 1 / shape);
        }
        double d = shape - 1.0 / 3;
        double c = 1 / Math.sqrt(9 * d);
        while (true) {
            double normal;
            double v;
            do {
                normal = nextGaussian();
                v = 1 + c * normal;
            } while (v <= 0);
            v = v * v * v;
            double uniform = nextDouble();
            double squared = normal * normal;
            if (uniform < 1 - 0.0331 * squared * squared) return d * v;
            if (Math.log(uniform) < 0.5 * squared + d * (1 - v + Math.log(v))) return d * v;
        }
    }

    /** Beta(alpha, beta) as the ratio of two Gamma draws. */
    public double beta(double alpha, double beta) {
        if (!(alpha > 0)) return 0;
        if (!(beta > 0)) return 1;
        double first = gamma(alpha);
        double second = gamma(beta);
        double total = first + second;
        return total > 0 ? first / total : alpha / (alpha + beta);
    }

    /**
     * The Beta concentration that gives mean {@code mean} a standard deviation
     * of {@code cv * mean}. A Beta variable cannot be more variable than
     * {@code p(1-p)} allows, so an over-ambitious request is capped at that
     * mathematical ceiling rather than rejected.
     *
     * @return alpha and beta, or {@code null} when the distribution degenerates to a point mass
     */
    public static double[] betaShape(double mean, double cv) {
        if (!(mean > 0) || !(mean < 1) || !(cv > 0)) return null;
        double maximumVariance = mean * (1 - mean);
        double variance = Math.min(cv * cv * mean * mean, maximumVariance * 0.999999);
        if (!(variance > 0)) return null;
        double concentration = maximumVariance / variance - 1;
        if (!(concentration > 0)) return null;
        return new double[]{mean * concentration, (1 - mean) * concentration};
    }

    // --------------------------------------------------------------- discrete

    /**
     * Trials up to and including the first success.
     *
     * @param logComplement {@code log1p(-p)}, hoisted by the caller because it is
     *                      constant whenever the success probability is
     * @return the 1-based trial index, or {@link Long#MAX_VALUE} if the first success
     *         lands beyond anything representable
     */
    public long geometric(double logComplement) {
        if (logComplement == 0) return Long.MAX_VALUE;
        if (Double.isInfinite(logComplement)) return 1;
        double position = Math.log(nextOpenDouble()) / logComplement;
        if (!(position < 9.007199254740992E15)) return Long.MAX_VALUE;
        return (long) position + 1;
    }

    /**
     * Binomial(trials, probability), exactly.
     *
     * <p>Small cases count successes by jumping between them, which costs about
     * {@code trials * probability} steps. Large cases recurse on a Beta split:
     * drawing {@code X ~ Beta(a, n+1-a)} and conditioning on whether the
     * probability falls below it halves the trial count each level, so the cost
     * is logarithmic in {@code trials} rather than linear. Both branches are
     * exact; neither is an approximation.
     */
    public int binomial(int trials, double probability) {
        if (trials <= 0 || !(probability > 0)) return 0;
        if (probability >= 1) return trials;
        if (probability > 0.5) return trials - binomial(trials, 1 - probability);
        if (trials < SPLIT_TRIALS || trials * probability < SPLIT_EXPECTED_SUCCESSES) {
            return binomialByJumping(trials, probability);
        }
        int head = 1 + trials / 2;
        double split = beta(head, trials + 1 - head);
        if (split >= probability) {
            return binomial(head - 1, clampUnit(probability / split));
        }
        return head + binomial(trials - head, clampUnit((probability - split) / (1 - split)));
    }

    private int binomialByJumping(int trials, double probability) {
        double logComplement = Math.log1p(-probability);
        int successes = 0;
        long position = 0;
        while (true) {
            long gap = geometric(logComplement);
            if (gap == Long.MAX_VALUE) return successes;
            position += gap;
            if (position > trials) return successes;
            successes++;
        }
    }

    private static double clampUnit(double value) {
        if (!(value > 0)) return 0;
        return value >= 1 ? 1 : value;
    }
}
