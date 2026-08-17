package probexperiment;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.SplittableRandom;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Dependency-free probability experiment server.
 *
 * Each experiment runs a configurable number of concurrent mini agents. Every
 * agent plays a configurable number of independent probability games and stores
 * every outcome as a compact 0/1 string.
 */
public final class Main {
    private static final int DEFAULT_AGENT_COUNT = 200;
    private static final int DEFAULT_GAMES_PER_AGENT = 300;
    private static final int MAX_AGENT_COUNT = 10_000;
    private static final int MAX_GAMES_PER_AGENT = 10_000;
    private static final int MAX_TOTAL_GAMES = 10_000_000;
    private static final int SWEEP_PROBABILITY_COUNT = 108;
    private static final Pattern SUCCESS_RATE = Pattern.compile("\\\"successRate\\\"\\s*:\\s*([0-9.eE+-]+)");
    private static final Pattern SEED = Pattern.compile("\\\"seed\\\"\\s*:\\s*(-?[0-9]+)");
    private static final Pattern AGENT_COUNT_INPUT = Pattern.compile("\\\"agentCount\\\"\\s*:\\s*([0-9]+)");
    private static final Pattern GAMES_PER_AGENT_INPUT = Pattern.compile("\\\"gamesPerAgent\\\"\\s*:\\s*([0-9]+)");
    private static final Pattern GAME_COST_INPUT = Pattern.compile("\\\"gameCost\\\"\\s*:\\s*([0-9.eE+-]+)");
    private static final Pattern WIN_REWARD_INPUT = Pattern.compile("\\\"winReward\\\"\\s*:\\s*([0-9.eE+-]+)");
    private static final Pattern ID_IN_JSON = Pattern.compile("\\\"id\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"");
    private static final Pattern CREATED_IN_JSON = Pattern.compile("\\\"createdAt\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"");
    private static final Pattern RATE_IN_JSON = Pattern.compile("\\\"successRate\\\"\\s*:\\s*([0-9.eE+-]+)");
    private static final Pattern TOTAL_SUCCESSES_IN_JSON = Pattern.compile("\\\"totalSuccesses\\\"\\s*:\\s*([0-9]+)");
    private static final Pattern DURATION_IN_JSON = Pattern.compile("\\\"durationMs\\\"\\s*:\\s*([0-9]+)");
    private static final Pattern AGENT_COUNT_IN_JSON = Pattern.compile("\\\"agentCount\\\"\\s*:\\s*([0-9]+)");
    private static final Pattern GAMES_PER_AGENT_IN_JSON = Pattern.compile("\\\"gamesPerAgent\\\"\\s*:\\s*([0-9]+)");
    private static final Pattern TOTAL_GAMES_IN_JSON = Pattern.compile("\\\"totalGames\\\"\\s*:\\s*([0-9]+)");
    private static final Pattern GAME_COST_IN_JSON = Pattern.compile("\\\"gameCost\\\"\\s*:\\s*([0-9.eE+-]+)");
    private static final Pattern WIN_REWARD_IN_JSON = Pattern.compile("\\\"winReward\\\"\\s*:\\s*([0-9.eE+-]+)");

    private final Path projectRoot;
    private final Path frontendRoot;
    private final Path dataRoot;
    private final Path trashRoot;
    private final Path sweepRoot;

    private Main(Path projectRoot) throws IOException {
        this.projectRoot = projectRoot.toAbsolutePath().normalize();
        this.frontendRoot = this.projectRoot.resolve("frontend").normalize();
        String configuredDataRoot = setting("experiment.dataRoot", "EXPERIMENT_DATA_ROOT", "");
        Path dataBase = configuredDataRoot.isBlank()
                ? this.projectRoot.resolve("data")
                : Path.of(configuredDataRoot).toAbsolutePath().normalize();
        this.dataRoot = dataBase.resolve("runs").normalize();
        this.trashRoot = dataBase.resolve("trash").normalize();
        this.sweepRoot = dataBase.resolve("sweeps").normalize();
        Files.createDirectories(dataRoot);
        Files.createDirectories(trashRoot);
        Files.createDirectories(sweepRoot);
    }

    public static void main(String[] args) throws Exception {
        Path root = Path.of(System.getProperty("experiment.root", "."));
        String host = setting("experiment.host", "HOST", "127.0.0.1");
        int port = Integer.parseInt(setting("experiment.port", "PORT", "8080"));
        Main app = new Main(root);
        HttpServer server = HttpServer.create(new InetSocketAddress(host, port), 0);
        server.createContext("/api/runs", app::handleRuns);
        server.createContext("/api/sweeps", app::handleSweeps);
        server.createContext("/api/health", exchange -> app.sendJson(exchange, 200, "{\"status\":\"ok\"}"));
        server.createContext("/", app::serveStatic);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.start();
        System.out.println("Probability Lab is running on " + host + ":" + port);
        System.out.println("Saved runs: " + app.dataRoot);
    }

    private void handleRuns(HttpExchange exchange) throws IOException {
        try {
            String method = exchange.getRequestMethod();
            String path = exchange.getRequestURI().getPath();
            if ("GET".equals(method) && "/api/runs".equals(path)) {
                sendJson(exchange, 200, listRuns());
                return;
            }
            if ("POST".equals(method) && "/api/runs".equals(path)) {
                String body = readBody(exchange);
                double rate = findDouble(SUCCESS_RATE, body, 0.01);
                if (!Double.isFinite(rate) || rate < 0 || rate > 1) {
                    sendJson(exchange, 400, "{\"error\":\"successRate must be between 0 and 1\"}");
                    return;
                }
                long requestedAgents = findLong(AGENT_COUNT_INPUT, body, DEFAULT_AGENT_COUNT);
                long requestedGames = findLong(GAMES_PER_AGENT_INPUT, body, DEFAULT_GAMES_PER_AGENT);
                if (requestedAgents < 1 || requestedAgents > MAX_AGENT_COUNT) {
                    sendJson(exchange, 400, "{\"error\":\"agentCount must be between 1 and " + MAX_AGENT_COUNT + "\"}");
                    return;
                }
                if (requestedGames < 1 || requestedGames > MAX_GAMES_PER_AGENT) {
                    sendJson(exchange, 400, "{\"error\":\"gamesPerAgent must be between 1 and " + MAX_GAMES_PER_AGENT + "\"}");
                    return;
                }
                int agentCount = (int) requestedAgents;
                int gamesPerAgent = (int) requestedGames;
                long totalGames = (long) agentCount * gamesPerAgent;
                if (totalGames > MAX_TOTAL_GAMES) {
                    sendJson(exchange, 400, "{\"error\":\"The experiment is limited to " + MAX_TOTAL_GAMES + " total games\"}");
                    return;
                }
                double gameCost = findDouble(GAME_COST_INPUT, body, 1.0);
                double winReward = findDouble(WIN_REWARD_INPUT, body, 100.0);
                if (!Double.isFinite(gameCost) || gameCost < 0 || gameCost > 1_000_000_000) {
                    sendJson(exchange, 400, "{\"error\":\"gameCost must be between 0 and 1,000,000,000\"}");
                    return;
                }
                if (!Double.isFinite(winReward) || winReward < 0 || winReward > 1_000_000_000) {
                    sendJson(exchange, 400, "{\"error\":\"winReward must be between 0 and 1,000,000,000\"}");
                    return;
                }
                long seed = findLong(SEED, body, new SplittableRandom().nextLong());
                RunResult result = runExperiment(rate, seed, agentCount, gamesPerAgent, gameCost, winReward);
                String json = result.toJson();
                saveRun(result.id(), json);
                sendJson(exchange, 201, json);
                return;
            }
            if ("GET".equals(method) && path.startsWith("/api/runs/")) {
                String id = path.substring("/api/runs/".length());
                if (!id.matches("[a-zA-Z0-9-]+")) {
                    sendJson(exchange, 400, "{\"error\":\"Invalid run id\"}");
                    return;
                }
                Path file = dataRoot.resolve(id + ".json").normalize();
                if (!file.startsWith(dataRoot) || !Files.exists(file)) {
                    sendJson(exchange, 404, "{\"error\":\"Run not found\"}");
                    return;
                }
                sendJson(exchange, 200, Files.readString(file));
                return;
            }
            if ("DELETE".equals(method) && path.startsWith("/api/runs/")) {
                String id = path.substring("/api/runs/".length());
                if (!id.matches("[a-zA-Z0-9-]+")) {
                    sendJson(exchange, 400, "{\"error\":\"Invalid run id\"}");
                    return;
                }
                Path file = dataRoot.resolve(id + ".json").normalize();
                if (!file.startsWith(dataRoot) || !Files.exists(file)) {
                    sendJson(exchange, 404, "{\"error\":\"Run not found\"}");
                    return;
                }
                Path recoverableCopy = trashRoot.resolve(id + "-" + Instant.now().toEpochMilli() + ".json").normalize();
                if (!recoverableCopy.startsWith(trashRoot)) {
                    sendJson(exchange, 400, "{\"error\":\"Invalid deletion target\"}");
                    return;
                }
                Files.move(file, recoverableCopy, StandardCopyOption.REPLACE_EXISTING);
                sendJson(exchange, 200, "{\"deleted\":true,\"recoverable\":true,\"id\":\"" + id + "\"}");
                return;
            }
            sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
        } catch (Exception error) {
            error.printStackTrace();
            sendJson(exchange, 500, "{\"error\":\"" + jsonEscape(error.getMessage()) + "\"}");
        }
    }

    private void handleSweeps(HttpExchange exchange) throws IOException {
        try {
            String method = exchange.getRequestMethod();
            String path = exchange.getRequestURI().getPath();
            if ("POST".equals(method) && "/api/sweeps".equals(path)) {
                String body = readBody(exchange);
                long requestedAgents = findLong(AGENT_COUNT_INPUT, body, DEFAULT_AGENT_COUNT);
                long requestedGames = findLong(GAMES_PER_AGENT_INPUT, body, DEFAULT_GAMES_PER_AGENT);
                if (requestedAgents < 1 || requestedAgents > MAX_AGENT_COUNT) {
                    sendJson(exchange, 400, "{\"error\":\"agentCount must be between 1 and " + MAX_AGENT_COUNT + "\"}");
                    return;
                }
                if (requestedGames < 1 || requestedGames > MAX_GAMES_PER_AGENT) {
                    sendJson(exchange, 400, "{\"error\":\"gamesPerAgent must be between 1 and " + MAX_GAMES_PER_AGENT + "\"}");
                    return;
                }
                int agentCount = (int) requestedAgents;
                int gamesPerAgent = (int) requestedGames;
                long totalGames = (long) SWEEP_PROBABILITY_COUNT * agentCount * gamesPerAgent;
                if (totalGames > MAX_TOTAL_GAMES) {
                    sendJson(exchange, 400, "{\"error\":\"The 108-probability sweep is limited to " + MAX_TOTAL_GAMES + " total games\"}");
                    return;
                }
                double gameCost = findDouble(GAME_COST_INPUT, body, 1.0);
                double winReward = findDouble(WIN_REWARD_INPUT, body, 100.0);
                if (!Double.isFinite(gameCost) || gameCost < 0 || gameCost > 1_000_000_000) {
                    sendJson(exchange, 400, "{\"error\":\"gameCost must be between 0 and 1,000,000,000\"}");
                    return;
                }
                if (!Double.isFinite(winReward) || winReward < 0 || winReward > 1_000_000_000) {
                    sendJson(exchange, 400, "{\"error\":\"winReward must be between 0 and 1,000,000,000\"}");
                    return;
                }
                long seed = findLong(SEED, body, new SplittableRandom().nextLong());
                SweepResult result = runSweep(seed, agentCount, gamesPerAgent, gameCost, winReward);
                String json = result.toJson();
                saveJson(sweepRoot, result.id(), json);
                sendJson(exchange, 201, json);
                return;
            }
            if ("GET".equals(method) && path.startsWith("/api/sweeps/")) {
                String id = path.substring("/api/sweeps/".length());
                if (!id.matches("[a-zA-Z0-9-]+")) {
                    sendJson(exchange, 400, "{\"error\":\"Invalid sweep id\"}");
                    return;
                }
                Path file = sweepRoot.resolve(id + ".json").normalize();
                if (!file.startsWith(sweepRoot) || !Files.exists(file)) {
                    sendJson(exchange, 404, "{\"error\":\"Sweep not found\"}");
                    return;
                }
                sendJson(exchange, 200, Files.readString(file));
                return;
            }
            sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
        } catch (Exception error) {
            error.printStackTrace();
            sendJson(exchange, 500, "{\"error\":\"" + jsonEscape(error.getMessage()) + "\"}");
        }
    }

    private RunResult runExperiment(double rate, long seed, int agentCount, int gamesPerAgent,
                                    double gameCost, double winReward) throws Exception {
        long started = System.nanoTime();
        List<Callable<AgentResult>> tasks = new ArrayList<>(agentCount);
        for (int agentIndex = 0; agentIndex < agentCount; agentIndex++) {
            final int index = agentIndex;
            tasks.add(() -> runAgent(index, rate, mixSeed(seed, index), gamesPerAgent));
        }

        List<AgentResult> agents = new ArrayList<>(agentCount);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            for (var future : executor.invokeAll(tasks)) {
                agents.add(future.get());
            }
        }
        agents.sort(Comparator.comparingInt(AgentResult::id));
        int totalSuccesses = agents.stream().mapToInt(AgentResult::successes).sum();
        long durationMs = Math.max(1, (System.nanoTime() - started) / 1_000_000);
        String id = Instant.now().toEpochMilli() + "-" + UUID.randomUUID().toString().substring(0, 8);
        return new RunResult(id, Instant.now().toString(), rate, seed, durationMs, totalSuccesses,
                agentCount, gamesPerAgent, gameCost, winReward, agents);
    }

    private AgentResult runAgent(int index, double rate, long agentSeed, int gamesPerAgent) {
        SplittableRandom random = new SplittableRandom(agentSeed);
        StringBuilder outcomes = new StringBuilder(gamesPerAgent);
        int successes = 0;
        for (int game = 0; game < gamesPerAgent; game++) {
            boolean success = random.nextDouble() < rate;
            outcomes.append(success ? '1' : '0');
            if (success) successes++;
        }
        return new AgentResult(index + 1, successes, outcomes.toString());
    }

    private SweepResult runSweep(long seed, int agentCount, int gamesPerAgent,
                                 double gameCost, double winReward) throws Exception {
        long started = System.nanoTime();
        List<Callable<SweepPoint>> tasks = new ArrayList<>(SWEEP_PROBABILITY_COUNT);
        for (int probabilityTenths = 1; probabilityTenths <= 9; probabilityTenths++) {
            final int tenths = probabilityTenths;
            tasks.add(() -> runSweepPoint(tenths, mixSeed(seed, tenths * 1_000_003), agentCount, gamesPerAgent));
        }
        for (int probabilityPercent = 1; probabilityPercent <= 99; probabilityPercent++) {
            final int tenths = probabilityPercent * 10;
            tasks.add(() -> runSweepPoint(tenths, mixSeed(seed, tenths * 1_000_003), agentCount, gamesPerAgent));
        }

        List<SweepPoint> points = new ArrayList<>(SWEEP_PROBABILITY_COUNT);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            for (var future : executor.invokeAll(tasks)) points.add(future.get());
        }
        points.sort(Comparator.comparingInt(SweepPoint::probabilityTenths));
        long durationMs = Math.max(1, (System.nanoTime() - started) / 1_000_000);
        String id = Instant.now().toEpochMilli() + "-" + UUID.randomUUID().toString().substring(0, 8);
        return new SweepResult(id, Instant.now().toString(), seed, durationMs, agentCount,
                gamesPerAgent, gameCost, winReward, points);
    }

    private SweepPoint runSweepPoint(int probabilityTenths, long probabilitySeed,
                                     int agentCount, int gamesPerAgent) {
        double probability = probabilityTenths / 1_000.0;
        int[] firstSuccessCounts = new int[gamesPerAgent];
        long totalSuccesses = 0;
        long successSquares = 0;
        int agentsWithSuccess = 0;
        long firstSuccessSum = 0;

        for (int agentIndex = 0; agentIndex < agentCount; agentIndex++) {
            SplittableRandom random = new SplittableRandom(mixSeed(probabilitySeed, agentIndex));
            int successes = 0;
            int firstSuccess = -1;
            for (int game = 0; game < gamesPerAgent; game++) {
                if (random.nextDouble() < probability) {
                    successes++;
                    if (firstSuccess < 0) firstSuccess = game;
                }
            }
            totalSuccesses += successes;
            successSquares += (long) successes * successes;
            if (firstSuccess >= 0) {
                agentsWithSuccess++;
                firstSuccessCounts[firstSuccess]++;
                firstSuccessSum += firstSuccess + 1L;
            }
        }

        int agentsWithoutSuccess = agentCount - agentsWithSuccess;
        double averageSuccesses = totalSuccesses / (double) agentCount;
        double variance = Math.max(0, successSquares / (double) agentCount - averageSuccesses * averageSuccesses);
        double averageFirstSuccess = agentsWithSuccess == 0 ? 0 : firstSuccessSum / (double) agentsWithSuccess;
        int medianFirstSuccess = waitPercentile(firstSuccessCounts, agentsWithoutSuccess, agentCount, .5, gamesPerAgent);
        int p90FirstSuccess = waitPercentile(firstSuccessCounts, agentsWithoutSuccess, agentCount, .9, gamesPerAgent);
        return new SweepPoint(probabilityTenths, totalSuccesses, agentsWithSuccess, agentsWithoutSuccess,
                averageSuccesses, Math.sqrt(variance), averageFirstSuccess, medianFirstSuccess,
                p90FirstSuccess, firstSuccessCounts);
    }

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

    private static long mixSeed(long seed, int agentIndex) {
        long value = seed + 0x9E3779B97F4A7C15L * (agentIndex + 1L);
        value = (value ^ (value >>> 30)) * 0xBF58476D1CE4E5B9L;
        value = (value ^ (value >>> 27)) * 0x94D049BB133111EBL;
        return value ^ (value >>> 31);
    }

    private void saveRun(String id, String json) throws IOException {
        saveJson(dataRoot, id, json);
    }

    private void saveJson(Path directory, String id, String json) throws IOException {
        Path finalFile = directory.resolve(id + ".json");
        Path tempFile = Files.createTempFile(directory, id, ".tmp");
        Files.writeString(tempFile, json, StandardCharsets.UTF_8);
        try {
            Files.move(tempFile, finalFile, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException unsupportedAtomicMove) {
            Files.move(tempFile, finalFile, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private String listRuns() throws IOException {
        List<String> metadata = new ArrayList<>();
        try (var files = Files.list(dataRoot)) {
            files.filter(path -> path.getFileName().toString().endsWith(".json"))
                    .sorted(Comparator.comparing(Path::getFileName).reversed())
                    .forEach(path -> {
                        try {
                            String json = readMetadataPrefix(path);
                            metadata.add("{\"id\":\"" + match(ID_IN_JSON, json) + "\"," +
                                    "\"createdAt\":\"" + match(CREATED_IN_JSON, json) + "\"," +
                                    "\"successRate\":" + match(RATE_IN_JSON, json) + "," +
                                    "\"agentCount\":" + match(AGENT_COUNT_IN_JSON, json) + "," +
                                    "\"gamesPerAgent\":" + match(GAMES_PER_AGENT_IN_JSON, json) + "," +
                                    "\"totalGames\":" + match(TOTAL_GAMES_IN_JSON, json) + "," +
                                    "\"gameCost\":" + matchOrDefault(GAME_COST_IN_JSON, json, "1.0") + "," +
                                    "\"winReward\":" + matchOrDefault(WIN_REWARD_IN_JSON, json, "100.0") + "," +
                                    "\"totalSuccesses\":" + match(TOTAL_SUCCESSES_IN_JSON, json) + "," +
                                    "\"durationMs\":" + match(DURATION_IN_JSON, json) + "}");
                        } catch (IOException ignored) {
                            // A damaged file is skipped; valid experiment files remain available.
                        }
                    });
        }
        return "[" + String.join(",", metadata) + "]";
    }

    private static String readMetadataPrefix(Path path) throws IOException {
        try (InputStream input = Files.newInputStream(path)) {
            return new String(input.readNBytes(2_048), StandardCharsets.UTF_8);
        }
    }

    private void serveStatic(HttpExchange exchange) throws IOException {
        if (!"GET".equals(exchange.getRequestMethod())) {
            exchange.sendResponseHeaders(405, -1);
            exchange.close();
            return;
        }
        String urlPath = URLDecoder.decode(exchange.getRequestURI().getPath(), StandardCharsets.UTF_8);
        if ("/".equals(urlPath)) urlPath = "/index.html";
        String relativePath = urlPath.substring(1).replace('\\', '/');
        Path normalizedRelativePath = Path.of(relativePath).normalize();
        if (normalizedRelativePath.isAbsolute() || normalizedRelativePath.startsWith("..")) {
            exchange.sendResponseHeaders(404, -1);
            exchange.close();
            return;
        }

        Path file = frontendRoot.resolve(normalizedRelativePath).normalize();
        byte[] content;
        String type;
        if (file.startsWith(frontendRoot) && Files.isRegularFile(file)) {
            content = Files.readAllBytes(file);
            type = Files.probeContentType(file);
        } else {
            String resourcePath = "/frontend/" + normalizedRelativePath.toString().replace('\\', '/');
            try (InputStream input = Main.class.getResourceAsStream(resourcePath)) {
                if (input == null) {
                    exchange.sendResponseHeaders(404, -1);
                    exchange.close();
                    return;
                }
                content = input.readAllBytes();
            }
            type = contentType(relativePath);
        }
        if (type == null) type = contentType(relativePath);
        exchange.getResponseHeaders().set("Content-Type", type + "; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-cache");
        exchange.sendResponseHeaders(200, content.length);
        exchange.getResponseBody().write(content);
        exchange.close();
    }

    private void sendJson(HttpExchange exchange, int status, String json) throws IOException {
        byte[] content = json.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, content.length);
        exchange.getResponseBody().write(content);
        exchange.close();
    }

    private static String readBody(HttpExchange exchange) throws IOException {
        try (InputStream input = exchange.getRequestBody()) {
            return new String(input.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static double findDouble(Pattern pattern, String text, double fallback) {
        Matcher matcher = pattern.matcher(text);
        return matcher.find() ? Double.parseDouble(matcher.group(1)) : fallback;
    }

    private static long findLong(Pattern pattern, String text, long fallback) {
        Matcher matcher = pattern.matcher(text);
        return matcher.find() ? Long.parseLong(matcher.group(1)) : fallback;
    }

    private static String match(Pattern pattern, String text) {
        Matcher matcher = pattern.matcher(text);
        return matcher.find() ? matcher.group(1) : "0";
    }

    private static String matchOrDefault(Pattern pattern, String text, String fallback) {
        Matcher matcher = pattern.matcher(text);
        return matcher.find() ? matcher.group(1) : fallback;
    }

    private static String jsonEscape(String value) {
        if (value == null) return "Unexpected server error";
        return value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ").replace("\r", " ");
    }

    private static String setting(String propertyName, String environmentName, String fallback) {
        String propertyValue = System.getProperty(propertyName);
        if (propertyValue != null && !propertyValue.isBlank()) return propertyValue;
        String environmentValue = System.getenv(environmentName);
        return environmentValue == null || environmentValue.isBlank() ? fallback : environmentValue;
    }

    private static String contentType(String path) {
        String lower = path.toLowerCase();
        if (lower.endsWith(".html")) return "text/html";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".js")) return "text/javascript";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".ico")) return "image/x-icon";
        return "application/octet-stream";
    }

    private record AgentResult(int id, int successes, String outcomes) {
        String toJson() {
            return "{\"id\":" + id + ",\"successes\":" + successes + ",\"outcomes\":\"" + outcomes + "\"}";
        }
    }

    private record SweepPoint(
            int probabilityTenths,
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
        String toJson(int agentCount, int gamesPerAgent, double gameCost, double winReward) {
            long totalGames = (long) agentCount * gamesPerAgent;
            long failures = totalGames - totalSuccesses;
            double actualRate = totalSuccesses / (double) totalGames;
            double observedNet = totalSuccesses * winReward - totalGames * gameCost;
            double probabilityPercent = probabilityTenths / 10.0;
            double probability = probabilityTenths / 1_000.0;
            StringBuilder json = new StringBuilder(256 + firstSuccessCounts.length * 3);
            json.append("{\"probabilityPercent\":").append(probabilityPercent).append(',')
                    .append("\"probability\":").append(probability).append(',')
                    .append("\"totalSuccesses\":").append(totalSuccesses).append(',')
                    .append("\"totalFailures\":").append(failures).append(',')
                    .append("\"actualRate\":").append(actualRate).append(',')
                    .append("\"agentsWithSuccess\":").append(agentsWithSuccess).append(',')
                    .append("\"agentsWithoutSuccess\":").append(agentsWithoutSuccess).append(',')
                    .append("\"averageSuccessesPerAgent\":").append(averageSuccessesPerAgent).append(',')
                    .append("\"successStdDev\":").append(successStdDev).append(',')
                    .append("\"averageFirstSuccess\":").append(averageFirstSuccess).append(',')
                    .append("\"medianFirstSuccess\":").append(medianFirstSuccess).append(',')
                    .append("\"p90FirstSuccess\":").append(p90FirstSuccess).append(',')
                    .append("\"observedNet\":").append(observedNet).append(',')
                    .append("\"firstSuccessCounts\":[");
            for (int i = 0; i < firstSuccessCounts.length; i++) {
                if (i > 0) json.append(',');
                json.append(firstSuccessCounts[i]);
            }
            return json.append("]}").toString();
        }
    }

    private record SweepResult(
            String id,
            String createdAt,
            long seed,
            long durationMs,
            int agentCount,
            int gamesPerAgent,
            double gameCost,
            double winReward,
            List<SweepPoint> points
    ) {
        String toJson() {
            long totalGames = (long) SWEEP_PROBABILITY_COUNT * agentCount * gamesPerAgent;
            Double firstWinningProbabilityPercent = null;
            Integer recommendedAttempts90 = null;
            for (SweepPoint point : points) {
                double probability = point.probabilityTenths() / 1_000.0;
                if (probability * winReward - gameCost > 1e-12) {
                    firstWinningProbabilityPercent = point.probabilityTenths() / 10.0;
                    recommendedAttempts90 = Math.max(1, (int) Math.ceil(Math.log(0.1) / Math.log(1 - probability)));
                    break;
                }
            }
            StringBuilder json = new StringBuilder(120_000);
            json.append("{\"id\":\"").append(id).append("\",")
                    .append("\"createdAt\":\"").append(createdAt).append("\",")
                    .append("\"seed\":").append(seed).append(',')
                    .append("\"durationMs\":").append(durationMs).append(',')
                    .append("\"agentCount\":").append(agentCount).append(',')
                    .append("\"gamesPerAgent\":").append(gamesPerAgent).append(',')
                    .append("\"gameCost\":").append(gameCost).append(',')
                    .append("\"winReward\":").append(winReward).append(',')
                    .append("\"probabilityCount\":").append(SWEEP_PROBABILITY_COUNT).append(',')
                    .append("\"totalGames\":").append(totalGames).append(',')
                    .append("\"breakEvenProbabilityPercent\":");
            if (winReward > 0) json.append(gameCost / winReward * 100);
            else if (gameCost == 0) json.append(0);
            else json.append("null");
            json.append(',')
                    .append("\"firstWinningProbabilityPercent\":")
                    .append(firstWinningProbabilityPercent == null ? "null" : firstWinningProbabilityPercent).append(',')
                    .append("\"recommendedAttempts90\":")
                    .append(recommendedAttempts90 == null ? "null" : recommendedAttempts90).append(',')
                    .append("\"points\":[");
            for (int i = 0; i < points.size(); i++) {
                if (i > 0) json.append(',');
                json.append(points.get(i).toJson(agentCount, gamesPerAgent, gameCost, winReward));
            }
            return json.append("]}").toString();
        }
    }

    private record RunResult(
            String id,
            String createdAt,
            double successRate,
            long seed,
            long durationMs,
            int totalSuccesses,
            int agentCount,
            int gamesPerAgent,
            double gameCost,
            double winReward,
            List<AgentResult> agents
    ) {
        String toJson() {
            StringBuilder json = new StringBuilder(75_000);
            json.append("{\"id\":\"").append(id).append("\",")
                    .append("\"createdAt\":\"").append(createdAt).append("\",")
                    .append("\"successRate\":").append(successRate).append(',')
                    .append("\"agentCount\":").append(agentCount).append(',')
                    .append("\"gamesPerAgent\":").append(gamesPerAgent).append(',')
                    .append("\"gameCost\":").append(gameCost).append(',')
                    .append("\"winReward\":").append(winReward).append(',')
                    .append("\"seed\":").append(seed).append(',')
                    .append("\"durationMs\":").append(durationMs).append(',')
                    .append("\"totalSuccesses\":").append(totalSuccesses).append(',')
                    .append("\"totalGames\":").append(agentCount * gamesPerAgent).append(',')
                    .append("\"agents\":[");
            for (int i = 0; i < agents.size(); i++) {
                if (i > 0) json.append(',');
                json.append(agents.get(i).toJson());
            }
            return json.append("]}").toString();
        }
    }
}
