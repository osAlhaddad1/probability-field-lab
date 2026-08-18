package probexperiment.json;

/**
 * A streaming JSON builder that tracks its own separators.
 *
 * <p>The engines emit tens of thousands of numbers per response, so this writes
 * straight into one {@link StringBuilder} rather than building an object tree.
 * Commas are the writer's responsibility, not the caller's: hand-placed commas
 * were the most common way the previous string-concatenated responses broke,
 * and a missing one produces invalid JSON far from where it was written.
 *
 * <p>Non-finite values are emitted as {@code null}. JSON has no NaN, and a
 * quantile of an empty tail genuinely is absent rather than zero — writing it
 * as {@code 0} would put a false point on a chart.
 */
public final class JsonWriter {
    /**
     * Significant digits kept for every number written.
     *
     * <p>Twelve strips binary representation noise — the 0.30000000000000004
     * kind — while staying far below the precision anything downstream can
     * use. Plotted series were briefly written at six digits to shrink the
     * payload; that rounding was large enough to show up as apparent error when
     * the engines were checked against closed forms, and saving a few kilobytes
     * is not worth making the output less true than the computation behind it.
     */
    private static final int NUMBER_DIGITS = 12;

    private final StringBuilder out;
    private long freshLevels = -1L;
    private int depth;

    public JsonWriter() {
        this(4_096);
    }

    public JsonWriter(int expectedSize) {
        this.out = new StringBuilder(expectedSize);
    }

    private void separate() {
        if ((freshLevels & (1L << depth)) == 0) out.append(',');
        else freshLevels &= ~(1L << depth);
    }

    private void open(char bracket) {
        separate();
        out.append(bracket);
        depth++;
        freshLevels |= 1L << depth;
    }

    private void close(char bracket) {
        depth--;
        out.append(bracket);
    }

    public JsonWriter beginObject() {
        open('{');
        return this;
    }

    public JsonWriter endObject() {
        close('}');
        return this;
    }

    public JsonWriter beginArray() {
        open('[');
        return this;
    }

    public JsonWriter endArray() {
        close(']');
        return this;
    }

    /** Starts a named object member. The following value call supplies its value. */
    public JsonWriter name(String name) {
        separate();
        out.append('"').append(Json.escape(name)).append("\":");
        // The value that follows belongs to this member, so it must not emit a separator.
        freshLevels |= 1L << depth;
        return this;
    }

    public JsonWriter beginObject(String name) {
        return name(name).beginObject();
    }

    public JsonWriter beginArray(String name) {
        return name(name).beginArray();
    }

    public JsonWriter field(String name, double value) {
        return name(name).value(value);
    }

    public JsonWriter field(String name, long value) {
        return name(name).value(value);
    }

    public JsonWriter field(String name, String value) {
        return name(name).value(value);
    }

    public JsonWriter field(String name, boolean value) {
        return name(name).value(value);
    }

    public JsonWriter value(double number) {
        separate();
        appendNumber(number, NUMBER_DIGITS);
        return this;
    }

    public JsonWriter value(long number) {
        separate();
        out.append(number);
        return this;
    }

    public JsonWriter value(String text) {
        separate();
        if (text == null) out.append("null");
        else out.append('"').append(Json.escape(text)).append('"');
        return this;
    }

    public JsonWriter value(boolean flag) {
        separate();
        out.append(flag);
        return this;
    }

    public JsonWriter nullValue() {
        separate();
        out.append("null");
        return this;
    }

    /** A plotted series. */
    public JsonWriter series(String name, double[] values) {
        return series(name, values, 0, values.length);
    }

    public JsonWriter series(String name, double[] values, int from, int to) {
        name(name);
        separate();
        out.append('[');
        for (int index = from; index < to; index++) {
            if (index > from) out.append(',');
            appendNumber(values[index], NUMBER_DIGITS);
        }
        out.append(']');
        return this;
    }

    public JsonWriter series(String name, int[] values) {
        name(name);
        separate();
        out.append('[');
        for (int index = 0; index < values.length; index++) {
            if (index > 0) out.append(',');
            out.append(values[index]);
        }
        out.append(']');
        return this;
    }

    public JsonWriter series(String name, long[] values) {
        name(name);
        separate();
        out.append('[');
        for (int index = 0; index < values.length; index++) {
            if (index > 0) out.append(',');
            out.append(values[index]);
        }
        out.append(']');
        return this;
    }

    /**
     * Writes a byte array of ASCII characters as a JSON string.
     *
     * <p>Outcome strings can run to hundreds of millions of characters, so this
     * copies straight into the output buffer rather than materialising an
     * intermediate String and briefly doubling the memory held.
     */
    public JsonWriter asciiField(String name, byte[] value, int length) {
        name(name);
        separate();
        out.append('"');
        for (int index = 0; index < length; index++) out.append((char) value[index]);
        out.append('"');
        return this;
    }

    /** Inserts already-formatted JSON, for values assembled elsewhere. */
    public JsonWriter raw(String json) {
        separate();
        out.append(json);
        return this;
    }

    private void appendNumber(double value, int digits) {
        if (!Double.isFinite(value)) {
            out.append("null");
            return;
        }
        if (value == 0) {
            out.append('0');
            return;
        }
        double rounded = round(value, digits);
        if (rounded == Math.rint(rounded) && Math.abs(rounded) < 1e15) {
            out.append((long) rounded);
            return;
        }
        out.append(Double.toString(rounded));
    }

    /** Rounds to a number of significant digits, which is what removes binary representation noise. */
    private static double round(double value, int digits) {
        double magnitude = Math.abs(value);
        int exponent = (int) Math.floor(Math.log10(magnitude));
        int shift = digits - 1 - exponent;
        if (shift > 300 || shift < -300) return value;
        double scale = Math.pow(10, shift);
        double scaled = value * scale;
        if (!Double.isFinite(scaled)) return value;
        return Math.rint(scaled) / scale;
    }

    public int size() {
        return out.length();
    }

    @Override
    public String toString() {
        return out.toString();
    }
}
