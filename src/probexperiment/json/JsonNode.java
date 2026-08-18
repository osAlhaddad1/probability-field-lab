package probexperiment.json;

import java.util.Map;

/**
 * Typed, validating navigation over a parsed JSON object.
 *
 * <p>Reading and checking happen in the same call on purpose. In the previous
 * design every engine repeated the same shape of guard — pull a number, test it
 * for finiteness, test it against a range, build an error string — and each
 * repetition was a chance to forget one of the three. Here a range is part of
 * asking for the value, and a violation raises {@link Json.JsonException},
 * which the HTTP layer already renders as a 400 with the message intact.
 */
public final class JsonNode {
    private static final JsonNode EMPTY = new JsonNode(Map.of(), "");

    private final Map<?, ?> members;
    private final String path;

    private JsonNode(Map<?, ?> members, String path) {
        this.members = members;
        this.path = path;
    }

    public static JsonNode of(Object value) {
        return value instanceof Map<?, ?> map ? new JsonNode(map, "") : EMPTY;
    }

    /** The named child object, or an empty node so callers can read defaults without null checks. */
    public JsonNode child(String name) {
        Object value = members.get(name);
        return value instanceof Map<?, ?> map ? new JsonNode(map, qualify(name)) : EMPTY;
    }

    public boolean has(String name) {
        return members.get(name) != null;
    }

    private String qualify(String name) {
        return path.isEmpty() ? name : path + "." + name;
    }

    private Number raw(String name) {
        Object value = members.get(name);
        if (value == null) return null;
        if (value instanceof Number number) return number;
        if (value instanceof String text && !text.isBlank()) {
            String trimmed = text.trim();
            try {
                return Long.valueOf(trimmed);
            } catch (NumberFormatException notWhole) {
                try {
                    return Double.valueOf(trimmed);
                } catch (NumberFormatException malformed) {
                    throw new Json.JsonException(qualify(name) + " is not a number");
                }
            }
        }
        throw new Json.JsonException(qualify(name) + " must be a number");
    }

    /** A finite number constrained to a range. Absent values fall back without being range-checked. */
    public double number(String name, double fallback, double minimum, double maximum) {
        Number value = raw(name);
        if (value == null) return fallback;
        double result = value.doubleValue();
        if (!Double.isFinite(result)) {
            throw new Json.JsonException(qualify(name) + " must be a finite number");
        }
        if (result < minimum || result > maximum) {
            throw new Json.JsonException(qualify(name) + " must be between " + trim(minimum) + " and " + trim(maximum)
                    + " but was " + trim(result));
        }
        return result;
    }

    public double number(String name, double fallback) {
        return number(name, fallback, Double.NEGATIVE_INFINITY, Double.POSITIVE_INFINITY);
    }

    /**
     * A whole number constrained to a range, rejecting fractional input rather
     * than truncating it. Values that arrived as integers keep every bit, so a
     * 64-bit seed survives the round trip intact.
     */
    public long integer(String name, long fallback, long minimum, long maximum) {
        Number value = raw(name);
        if (value == null) return fallback;
        long result;
        if (value instanceof Long whole) {
            result = whole;
        } else {
            double approximate = value.doubleValue();
            if (!Double.isFinite(approximate) || approximate != Math.rint(approximate)) {
                throw new Json.JsonException(qualify(name) + " must be a whole number");
            }
            if (Math.abs(approximate) > 9.007199254740992E15) {
                throw new Json.JsonException(qualify(name) + " is too large to represent exactly");
            }
            result = (long) approximate;
        }
        if (result < minimum || result > maximum) {
            throw new Json.JsonException(qualify(name) + " must be between " + minimum + " and " + maximum
                    + " but was " + result);
        }
        return result;
    }

    /** Any 64-bit whole number, with no range restriction. Used for seeds. */
    public long seed(String name, long fallback) {
        return integer(name, fallback, Long.MIN_VALUE, Long.MAX_VALUE);
    }

    public int integer(String name, int fallback, int minimum, int maximum) {
        return (int) integer(name, (long) fallback, minimum, maximum);
    }

    public String text(String name, String fallback) {
        Object value = members.get(name);
        return value instanceof String text ? text : fallback;
    }

    /** A string restricted to a known set, so a typo fails loudly instead of selecting a default. */
    public String choice(String name, String fallback, String... allowed) {
        Object value = members.get(name);
        if (value == null) return fallback;
        if (!(value instanceof String text)) throw new Json.JsonException(qualify(name) + " must be a string");
        for (String option : allowed) {
            if (option.equals(text)) return option;
        }
        throw new Json.JsonException(qualify(name) + " must be one of " + String.join(", ", allowed));
    }

    public boolean flag(String name, boolean fallback) {
        Object value = members.get(name);
        return value instanceof Boolean bool ? bool : fallback;
    }

    private static String trim(double value) {
        if (value == Double.NEGATIVE_INFINITY) return "-infinity";
        if (value == Double.POSITIVE_INFINITY) return "infinity";
        if (value == Math.rint(value) && Math.abs(value) < 1e15) return Long.toString((long) value);
        return Double.toString(value);
    }
}
