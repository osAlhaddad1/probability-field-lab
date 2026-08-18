package probexperiment.store;

import probexperiment.json.Json;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Durable storage for one kind of result.
 *
 * <p>Each engine gets its own store rather than sharing one keyed by type, so
 * adding an engine cannot collide with an existing set of files, and deleting
 * one engine's history cannot touch another's.
 *
 * <p>Writes go to a temporary file and are then moved into place, atomically
 * where the filesystem allows it. A result can take minutes to produce, and a
 * process that dies mid-write should cost you nothing rather than leave a
 * half-written file that parses as valid JSON right up to the point it stops.
 */
public final class RunStore {
    /** How much of a saved file to read when building an index entry. */
    private static final int HEADER_BYTES = 4_096;

    private final Path directory;
    private final Path trash;

    public RunStore(Path base, String name) throws IOException {
        this.directory = base.resolve(name).normalize();
        this.trash = base.resolve("trash").normalize();
        Files.createDirectories(directory);
        Files.createDirectories(trash);
    }

    public void save(String id, String json) throws IOException {
        Path finalFile = resolve(id);
        Path temporary = Files.createTempFile(directory, id, ".tmp");
        Files.writeString(temporary, json, StandardCharsets.UTF_8);
        try {
            Files.move(temporary, finalFile, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException atomicMoveUnsupported) {
            Files.move(temporary, finalFile, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    public Optional<String> load(String id) throws IOException {
        Path file = resolve(id);
        return Files.exists(file) ? Optional.of(Files.readString(file)) : Optional.empty();
    }

    /**
     * Moves a result into the shared trash folder instead of unlinking it. The
     * caller asked to remove it from the list, not to make it unrecoverable.
     */
    public boolean trash(String id) throws IOException {
        Path file = resolve(id);
        if (!Files.exists(file)) return false;
        Path destination = trash.resolve(id + "-" + Instant.now().toEpochMilli() + ".json").normalize();
        if (!destination.startsWith(trash)) throw new IOException("Invalid deletion target");
        Files.move(file, destination, StandardCopyOption.REPLACE_EXISTING);
        return true;
    }

    /**
     * Index entries, newest first. Only the scalar header of each file is read,
     * so listing stays fast no matter how large the stored results are.
     */
    public List<Map<String, Object>> index() throws IOException {
        List<Map<String, Object>> entries = new ArrayList<>();
        try (var files = Files.list(directory)) {
            files.filter(path -> path.getFileName().toString().endsWith(".json"))
                    .sorted(Comparator.comparing(Path::getFileName).reversed())
                    .forEach(path -> {
                        Map<String, Object> header = readHeader(path);
                        if (!header.isEmpty()) entries.add(header);
                    });
        }
        return entries;
    }

    private static Map<String, Object> readHeader(Path path) {
        try (InputStream input = Files.newInputStream(path)) {
            return Json.scalarPrefix(new String(input.readNBytes(HEADER_BYTES), StandardCharsets.UTF_8));
        } catch (IOException unreadable) {
            // A damaged file is skipped so one bad result cannot break the whole listing.
            return Map.of();
        }
    }

    private Path resolve(String id) {
        if (!id.matches("[a-zA-Z0-9-]+")) throw new IllegalArgumentException("Invalid identifier");
        Path file = directory.resolve(id + ".json").normalize();
        if (!file.startsWith(directory)) throw new IllegalArgumentException("Invalid identifier");
        return file;
    }
}
