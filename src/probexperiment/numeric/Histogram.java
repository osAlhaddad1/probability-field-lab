package probexperiment.numeric;

/**
 * A fixed-width weighted histogram.
 *
 * <p>Weights rather than counts, because the engines feed it exact probability
 * mass instead of tallies: a single universe contributes its whole outcome
 * distribution in one pass, so the histogram is an integral rather than a
 * sample. Values outside the range clamp into the edge bins, which is the
 * honest behaviour for a bounded chart.
 */
public final class Histogram {
    private final double low;
    private final double high;
    private final double width;
    private final double[] weights;
    private double total;

    public Histogram(double low, double high, int bins) {
        if (!(high > low)) {
            high = low + 1;
        }
        this.low = low;
        this.high = high;
        this.weights = new double[Math.max(1, bins)];
        this.width = (high - low) / this.weights.length;
    }

    public void add(double value, double weight) {
        if (!(weight > 0) || !Double.isFinite(value)) return;
        weights[binOf(value)] += weight;
        total += weight;
    }

    public int binOf(double value) {
        return binIndex(value, low, high, weights.length);
    }

    /** Bin index without needing an instance, for hot loops that accumulate into raw arrays. */
    public static int binIndex(double value, double low, double high, int bins) {
        int index = (int) ((value - low) / (high - low) * bins);
        return index < 0 ? 0 : index >= bins ? bins - 1 : index;
    }

    /** Replaces the contents with a raw weight array accumulated elsewhere. */
    public void load(double[] raw) {
        total = 0;
        for (int index = 0; index < weights.length; index++) {
            weights[index] = raw[index];
            total += raw[index];
        }
    }

    public void absorb(Histogram other) {
        for (int index = 0; index < weights.length; index++) weights[index] += other.weights[index];
        total += other.total;
    }

    public double total() {
        return total;
    }

    public double low() {
        return low;
    }

    public double high() {
        return high;
    }

    public int bins() {
        return weights.length;
    }

    /** Quantile with linear interpolation inside the straddled bin. */
    public double quantile(double probability) {
        if (!(total > 0)) return Double.NaN;
        double target = probability * total;
        double cumulative = 0;
        for (int index = 0; index < weights.length; index++) {
            double next = cumulative + weights[index];
            if (next >= target) {
                double within = weights[index] > 0 ? (target - cumulative) / weights[index] : .5;
                return low + (index + within) * width;
            }
            cumulative = next;
        }
        return high;
    }

    /**
     * Mean of the lowest {@code probability} share of the mass — the conditional
     * value at risk, which answers "when it goes badly, how badly" in a way a
     * single quantile cannot.
     */
    public double tailMean(double probability) {
        if (!(total > 0)) return Double.NaN;
        double target = probability * total;
        double taken = 0;
        double weighted = 0;
        for (int index = 0; index < weights.length && taken < target; index++) {
            double take = Math.min(weights[index], target - taken);
            weighted += take * (low + (index + .5) * width);
            taken += take;
        }
        return taken > 0 ? weighted / taken : Double.NaN;
    }

    /** Total mass strictly above {@code threshold}, interpolated inside the straddled bin. */
    public double massAbove(double threshold) {
        if (!(total > 0)) return 0;
        if (threshold <= low) return total;
        if (threshold >= high) return 0;
        int bin = binOf(threshold);
        double binStart = low + bin * width;
        double fractionAbove = 1 - (threshold - binStart) / width;
        double mass = weights[bin] * fractionAbove;
        for (int index = bin + 1; index < weights.length; index++) mass += weights[index];
        return mass;
    }

    /**
     * Normalised density, optionally folded down to {@code targetBins} so the
     * payload stays small without changing the shape of the curve.
     */
    public double[] density(int targetBins) {
        int factor = Math.max(1, weights.length / Math.max(1, targetBins));
        int reported = weights.length / factor;
        double[] density = new double[reported];
        for (int index = 0; index < reported; index++) {
            double sum = 0;
            for (int inner = 0; inner < factor; inner++) sum += weights[index * factor + inner];
            density[index] = total > 0 ? sum / total : 0;
        }
        return density;
    }
}
