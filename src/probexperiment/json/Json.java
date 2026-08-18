package probexperiment.json;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A small recursive-descent JSON reader.
 *
 * <p>It exists to replace pattern matching against request bodies. Regular
 * expressions cannot see structure, so they cannot tell a nested
 * {@code {"winReward": {"mean": 5}}} from a top-level {@code "mean"}, and they
 * silently accept malformed input by finding a number somewhere inside it. A
 * parser refuses instead, which is what you want standing in front of an engine
 * that will happily spend minutes computing on a misread parameter.
 *
 * <p>Values map to {@link Map}, {@link List}, {@link Double}, {@link String},
 * {@link Boolean} and {@code null}.
 */
public final class Json {
    private final String text;
    private int cursor;

    private Json(String text) {
        this.text = text;
    }

    /** Parses a complete document. Trailing content other than whitespace is an error. */
    public static Object parse(String text) {
        if (text == null) throw new JsonException("Empty request body");
        Json reader = new Json(text);
        reader.skipWhitespace();
        Object value = reader.readValue(0);
        reader.skipWhitespace();
        if (reader.cursor < text.length()) {
            throw new JsonException("Unexpected content after the JSON value at position " + reader.cursor);
        }
        return value;
    }

    /** Parses a document that must be an object, and wraps it for typed reading. */
    public static JsonNode parseObject(String text) {
        Object value = parse(text);
        if (!(value instanceof Map<?, ?>)) throw new JsonException("Expected a JSON object");
        return JsonNode.of(value);
    }

    private Object readValue(int depth) {
        if (depth > 64) throw new JsonException("JSON nesting is too deep");
        if (cursor >= text.length()) throw new JsonException("Unexpected end of JSON");
        char symbol = text.charAt(cursor);
        return switch (symbol) {
            case '{' -> readObject(depth);
            case '[' -> readArray(depth);
            case '"' -> readString();
            case 't' -> readLiteral("true", Boolean.TRUE);
            case 'f' -> readLiteral("false", Boolean.FALSE);
            case 'n' -> readLiteral("null", null);
            default -> readNumber();
        };
    }

    private Map<String, Object> readObject(int depth) {
        Map<String, Object> members = new LinkedHashMap<>();
        cursor++;
        skipWhitespace();
        if (peek() == '}') {
            cursor++;
            return members;
        }
        while (true) {
            skipWhitespace();
            if (peek() != '"') throw new JsonException("Expected a field name at position " + cursor);
            String name = readString();
            skipWhitespace();
            if (peek() != ':') throw new JsonException("Expected ':' after \"" + name + "\"");
            cursor++;
            skipWhitespace();
            members.put(name, readValue(depth + 1));
            skipWhitespace();
            char symbol = peek();
            if (symbol == ',') {
                cursor++;
                continue;
            }
            if (symbol == '}') {
                cursor++;
                return members;
            }
            throw new JsonException("Expected ',' or '}' at position " + cursor);
        }
    }

    private List<Object> readArray(int depth) {
        List<Object> items = new ArrayList<>();
        cursor++;
        skipWhitespace();
        if (peek() == ']') {
            cursor++;
            return items;
        }
        while (true) {
            skipWhitespace();
            items.add(readValue(depth + 1));
            skipWhitespace();
            char symbol = peek();
            if (symbol == ',') {
                cursor++;
                continue;
            }
            if (symbol == ']') {
                cursor++;
                return items;
            }
            throw new JsonException("Expected ',' or ']' at position " + cursor);
        }
    }

    private String readString() {
        cursor++;
        StringBuilder value = new StringBuilder();
        while (true) {
            if (cursor >= text.length()) throw new JsonException("Unterminated string");
            char symbol = text.charAt(cursor++);
            if (symbol == '"') return value.toString();
            if (symbol != '\\') {
                value.append(symbol);
                continue;
            }
            if (cursor >= text.length()) throw new JsonException("Unterminated escape sequence");
            char escaped = text.charAt(cursor++);
            switch (escaped) {
                case '"' -> value.append('"');
                case '\\' -> value.append('\\');
                case '/' -> value.append('/');
                case 'b' -> value.append('\b');
                case 'f' -> value.append('\f');
                case 'n' -> value.append('\n');
                case 'r' -> value.append('\r');
                case 't' -> value.append('\t');
                case 'u' -> {
                    if (cursor + 4 > text.length()) throw new JsonException("Truncated unicode escape");
                    value.append((char) Integer.parseInt(text.substring(cursor, cursor + 4), 16));
                    cursor += 4;
                }
                default -> throw new JsonException("Unsupported escape \\" + escaped);
            }
        }
    }

    private Object readLiteral(String literal, Object value) {
        if (!text.startsWith(literal, cursor)) {
            throw new JsonException("Unrecognised literal at position " + cursor);
        }
        cursor += literal.length();
        return value;
    }

    /**
     * Reads a number, keeping whole values as {@link Long}.
     *
     * <p>Seeds are the reproducibility contract of this project and routinely
     * exceed the 53 bits a double can hold exactly. Parsing everything as a
     * double would silently round one, and the run it identifies would never be
     * reproducible again.
     */
    private Number readNumber() {
        int start = cursor;
        if (peek() == '-' || peek() == '+') cursor++;
        while (cursor < text.length()) {
            char symbol = text.charAt(cursor);
            if ((symbol >= '0' && symbol <= '9') || symbol == '.' || symbol == 'e' || symbol == 'E'
                    || symbol == '+' || symbol == '-') {
                cursor++;
            } else {
                break;
            }
        }
        if (cursor == start) throw new JsonException("Expected a value at position " + start);
        String token = text.substring(start, cursor);
        if (isIntegral(token)) {
            try {
                return Long.valueOf(token);
            } catch (NumberFormatException tooLarge) {
                // Falls through to the floating-point reading below.
            }
        }
        try {
            return Double.valueOf(token);
        } catch (NumberFormatException malformed) {
            throw new JsonException("Malformed number \"" + token + "\"");
        }
    }

    private static boolean isIntegral(String token) {
        int index = token.charAt(0) == '-' || token.charAt(0) == '+' ? 1 : 0;
        if (index >= token.length()) return false;
        for (; index < token.length(); index++) {
            char symbol = token.charAt(index);
            if (symbol < '0' || symbol > '9') return false;
        }
        return true;
    }

    private char peek() {
        if (cursor >= text.length()) throw new JsonException("Unexpected end of JSON");
        return text.charAt(cursor);
    }

    private void skipWhitespace() {
        while (cursor < text.length()) {
            char symbol = text.charAt(cursor);
            if (symbol == ' ' || symbol == '\t' || symbol == '\n' || symbol == '\r') cursor++;
            else break;
        }
    }

    /**
     * Reads the leading scalar members of a truncated object and stops cleanly
     * at the first array, nested object, or end of the fragment.
     *
     * <p>A saved run is mostly one enormous array, but everything the index
     * needs sits in front of it as plain scalars. This lets a listing read a
     * couple of kilobytes per file instead of parsing megabytes, without
     * resorting to pattern matching that cannot tell nesting apart. Files
     * written before the store existed parse identically, so no migration is
     * needed.
     */
    public static Map<String, Object> scalarPrefix(String fragment) {
        Map<String, Object> members = new LinkedHashMap<>();
        if (fragment == null) return members;
        Json reader = new Json(fragment);
        try {
            reader.skipWhitespace();
            if (reader.peek() != '{') return members;
            reader.cursor++;
            while (true) {
                reader.skipWhitespace();
                if (reader.peek() == '}') return members;
                if (reader.peek() != '"') return members;
                String name = reader.readString();
                reader.skipWhitespace();
                if (reader.peek() != ':') return members;
                reader.cursor++;
                reader.skipWhitespace();
                char symbol = reader.peek();
                if (symbol == '[' || symbol == '{') return members;
                members.put(name, reader.readValue(0));
                reader.skipWhitespace();
                if (reader.peek() != ',') return members;
                reader.cursor++;
            }
        } catch (JsonException truncated) {
            // The fragment ended mid-value; whatever was already read is still good.
            return members;
        }
    }

    /** Escapes a string for inclusion in JSON output, including the control range. */
    public static String escape(String value) {
        if (value == null) return "";
        StringBuilder escaped = new StringBuilder(value.length() + 16);
        for (int index = 0; index < value.length(); index++) {
            char symbol = value.charAt(index);
            switch (symbol) {
                case '"' -> escaped.append("\\\"");
                case '\\' -> escaped.append("\\\\");
                case '\n' -> escaped.append("\\n");
                case '\r' -> escaped.append("\\r");
                case '\t' -> escaped.append("\\t");
                case '\b' -> escaped.append("\\b");
                case '\f' -> escaped.append("\\f");
                default -> {
                    if (symbol < 0x20) escaped.append(String.format("\\u%04x", (int) symbol));
                    else escaped.append(symbol);
                }
            }
        }
        return escaped.toString();
    }

    /** Thrown for any malformed or structurally unexpected input. */
    public static final class JsonException extends RuntimeException {
        public JsonException(String message) {
            super(message);
        }
    }
}
