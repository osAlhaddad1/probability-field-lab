package probexperiment.numeric;

/**
 * The small amount of classical statistics the engines need.
 *
 * <p>Sensitivity is measured on ranks rather than raw values. A rank
 * correlation survives the monotone but wildly non-linear relationships this
 * model produces — a log-normal cost feeding a geometric waiting time feeding a
 * profit — where an ordinary correlation would understate a parameter that
 * dominates the outcome simply because it does so along a curve.
 */
public final class Statistics {
    private Statistics() {
    }

    /**
     * Index permutation that sorts {@code values} ascending, by merge sort on
     * an int array. Merge sort because it is stable, which keeps tied
     * parameter values in a deterministic order and so keeps a whole run
     * reproducible from its seed.
     */
    public static int[] order(double[] values, int count) {
        int[] order = new int[count];
        for (int index = 0; index < count; index++) order[index] = index;
        if (count < 2) return order;
        mergeSort(order, new int[count], 0, count, values);
        return order;
    }

    private static void mergeSort(int[] order, int[] scratch, int from, int to, double[] values) {
        if (to - from < 2) return;
        int middle = (from + to) >>> 1;
        mergeSort(order, scratch, from, middle, values);
        mergeSort(order, scratch, middle, to, values);
        int left = from;
        int right = middle;
        int cursor = from;
        while (left < middle && right < to) {
            scratch[cursor++] = values[order[left]] <= values[order[right]] ? order[left++] : order[right++];
        }
        while (left < middle) scratch[cursor++] = order[left++];
        while (right < to) scratch[cursor++] = order[right++];
        System.arraycopy(scratch, from, order, from, to - from);
    }

    /** Ranks from 1, with tied values sharing their average rank. */
    public static double[] ranks(double[] values, int count) {
        int[] order = order(values, count);
        double[] ranks = new double[count];
        int index = 0;
        while (index < count) {
            int tail = index;
            while (tail + 1 < count && values[order[tail + 1]] == values[order[index]]) tail++;
            double shared = (index + tail) / 2.0 + 1;
            for (int position = index; position <= tail; position++) ranks[order[position]] = shared;
            index = tail + 1;
        }
        return ranks;
    }

    /** Rescales in place to zero mean and unit variance; a constant series becomes all zeros. */
    public static void standardise(double[] values, int count) {
        double mean = 0;
        for (int index = 0; index < count; index++) mean += values[index];
        mean /= count;
        double variance = 0;
        for (int index = 0; index < count; index++) {
            double centred = values[index] - mean;
            variance += centred * centred;
        }
        variance /= count;
        double deviation = Math.sqrt(variance);
        if (!(deviation > 0)) {
            java.util.Arrays.fill(values, 0, count, 0);
            return;
        }
        for (int index = 0; index < count; index++) values[index] = (values[index] - mean) / deviation;
    }

    /**
     * Solves a small dense system by Gauss-Jordan elimination with partial
     * pivoting. A singular row yields a zero coefficient rather than an
     * exception, which is the right answer when two parameters are perfectly
     * collinear and the model genuinely cannot attribute the effect to either.
     */
    public static double[] solve(double[][] matrix, double[] vector) {
        int size = vector.length;
        double[][] work = new double[size][size + 1];
        for (int row = 0; row < size; row++) {
            System.arraycopy(matrix[row], 0, work[row], 0, size);
            work[row][size] = vector[row];
        }
        for (int column = 0; column < size; column++) {
            int pivot = column;
            for (int row = column + 1; row < size; row++) {
                if (Math.abs(work[row][column]) > Math.abs(work[pivot][column])) pivot = row;
            }
            if (Math.abs(work[pivot][column]) < 1e-12) continue;
            double[] swap = work[column];
            work[column] = work[pivot];
            work[pivot] = swap;
            for (int row = 0; row < size; row++) {
                if (row == column) continue;
                double factor = work[row][column] / work[column][column];
                for (int position = column; position <= size; position++) {
                    work[row][position] -= factor * work[column][position];
                }
            }
        }
        double[] solution = new double[size];
        for (int row = 0; row < size; row++) {
            solution[row] = Math.abs(work[row][row]) < 1e-12 ? 0 : work[row][size] / work[row][row];
        }
        return solution;
    }

    /** Interpolated quantile of an already sorted prefix. */
    public static double sortedQuantile(double[] sorted, int count, double probability) {
        if (count < 1) return Double.NaN;
        if (count == 1) return sorted[0];
        double position = probability * (count - 1);
        int lower = (int) Math.floor(position);
        int upper = Math.min(count - 1, lower + 1);
        double weight = position - lower;
        return sorted[lower] * (1 - weight) + sorted[upper] * weight;
    }
}
