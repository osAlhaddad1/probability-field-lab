package probexperiment;

import com.sun.net.httpserver.HttpServer;
import probexperiment.engine.Experiment;
import probexperiment.engine.ExperimentEndpoint;
import probexperiment.engine.FixedOddsExperiment;
import probexperiment.engine.SweepExperiment;
import probexperiment.engine.UncertainExperiment;
import probexperiment.http.Router;
import probexperiment.http.StaticFiles;
import probexperiment.store.RunStore;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.Executors;

/**
 * Dependency-free probability laboratory.
 *
 * <p>This class does nothing but assemble the application: work out where data
 * lives, give each experiment a store and its routes, and start listening.
 * Adding a mode means writing one {@link Experiment} and adding it to the list
 * below.
 */
public final class Main {
    /** The modes the lab offers, in the order they appear in the dashboard. */
    private static final List<Experiment> EXPERIMENTS = List.of(
            new FixedOddsExperiment(),
            new SweepExperiment(),
            new UncertainExperiment());

    private Main() {
    }

    public static void main(String[] args) throws Exception {
        Path projectRoot = Path.of(System.getProperty("experiment.root", ".")).toAbsolutePath().normalize();
        Path dataRoot = resolveDataRoot(projectRoot);
        String host = setting("experiment.host", "HOST", "127.0.0.1");
        int port = Integer.parseInt(setting("experiment.port", "PORT", "8080"));

        Router router = new Router();
        for (Experiment experiment : EXPERIMENTS) {
            ExperimentEndpoint.register(router, experiment, new RunStore(dataRoot, experiment.path()));
        }
        router.route("GET", "/api/health", request -> "{\"status\":\"ok\"}");
        router.route("GET", "/api/modes", request -> modes());

        HttpServer server = HttpServer.create(new InetSocketAddress(host, port), 0);
        server.createContext("/api", router);
        server.createContext("/", new StaticFiles(projectRoot.resolve("frontend").normalize(), "/frontend/"));
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.start();

        System.out.println("Probability Lab is running on " + host + ":" + port);
        System.out.println("Stored results: " + dataRoot);
        for (Experiment experiment : EXPERIMENTS) {
            System.out.println("  /api/" + experiment.path() + "  " + experiment.title());
        }
    }

    /** Lets the dashboard discover the available modes instead of hard-coding them. */
    private static String modes() {
        StringBuilder json = new StringBuilder("[");
        for (int index = 0; index < EXPERIMENTS.size(); index++) {
            Experiment experiment = EXPERIMENTS.get(index);
            if (index > 0) json.append(',');
            json.append("{\"path\":\"").append(experiment.path())
                    .append("\",\"title\":\"").append(experiment.title()).append("\"}");
        }
        return json.append(']').toString();
    }

    private static Path resolveDataRoot(Path projectRoot) throws IOException {
        String configured = setting("experiment.dataRoot", "EXPERIMENT_DATA_ROOT", "");
        return configured.isBlank()
                ? projectRoot.resolve("data")
                : Path.of(configured).toAbsolutePath().normalize();
    }

    private static String setting(String propertyName, String environmentName, String fallback) {
        String property = System.getProperty(propertyName);
        if (property != null && !property.isBlank()) return property;
        String environment = System.getenv(environmentName);
        return environment == null || environment.isBlank() ? fallback : environment;
    }
}
