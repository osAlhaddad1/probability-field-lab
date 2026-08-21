# Probability Field Lab

A dependency-free Java + JavaScript probability experiment. Each run launches a configurable number of concurrent mini agents, and every agent plays a configurable number of independent probability games. The defaults are **200 agents × 300 games = 60,000 outcomes**. Each game can also have a configurable cost and each success a configurable reward.

The dashboard has three modes:

- **Known odds** runs one detailed field at a chosen success probability.
- **Unknown odds** repeats the complete field 1,089 times: 0.01%–1.00% in 0.01% steps, then 1.1%–99.9% in 0.1% steps. It builds a ten-graph decision atlas around profit, risk, waiting time, and automatic move-on boundaries. Graph 01 includes an interactive deadline planner for either a concrete net-profit target or a realized ROI target from 1%–500%.
- **Uncertain world** answers a different question: what to do when you are not sure of the numbers themselves, and you get better at the game as you play.

## Uncertain world

Six parameters — entry cost, cost per attempt, reward per win, starting win chance, improvement per attempt, and skill ceiling — each carry three layers of belief:

1. a **best guess**, the single value you would name if forced;
2. an **uncertainty**, how far off that guess could be, as a percentage of it;
3. a **doubt about the doubt**, how much you trust that error bar.

Layers two and three are explored by Monte Carlo. A *world* is one draw of how uncertain everything is; a *universe* inside it is one draw of what the parameters actually are. The game itself is never simulated: inside a universe every parameter is fixed, so the attempt that produces the first win has a closed-form distribution and the whole outcome distribution is integrated exactly in one sweep. Sampling error therefore comes only from the uncertainty you declared, never from how many dice the computer rolled.

Learning follows one of two laws. Under **log-odds gain** the odds of winning grow by a fixed fraction each attempt, which can never leave `(0, 1)` and needs no ceiling. Under **approach a ceiling** each attempt closes a fixed fraction of the gap to a skill limit you name. Cost and reward are drawn from log-normal distributions with exactly the mean and coefficient of variation you asked for; probabilities are drawn from Beta distributions the same way, capped at the most variance `p(1 − p)` allows.

The mode returns a recommended stopping point, the profit distribution there, and a three-way split of the risk under the law of total variance: the luck of the game, not knowing the parameters, and not knowing your own error bars. Only the first is unavoidable, so the split says whether to gather information or accept the odds. Rank-regression sensitivity ranks which unknown drives the outcome, and a value-of-information calculation puts a figure on what learning each parameter exactly would be worth — the most you should pay to find out.

**You are never asked how much computation to do.** The number of worlds is a trade of accuracy against time expressed in units nobody cares about, so the engine sizes its own run: a pilot measures how much the answer moves between worlds, then solves for the count that holds the sampling error under 1% of the outcome's own spread, re-checking that estimate as it grows. Every result reports the precision it actually reached, and the headline profit carries that error bar.

## Run it

The recommended development command starts both the Java API and JavaScript frontend:

```powershell
npm run dev
```

Then open the address printed in the terminal. It normally uses [http://localhost:8080](http://localhost:8080); if that port is occupied, the development command automatically selects the next available port. The server stays live until you press `Ctrl+C`.

You can also double-click `run.bat`. Both options compile the project with the installed Java JDK and run the same combined frontend/API server.

## What is saved

Detailed experiments are stored as JSON under `data/runs/`. Probability sweeps are stored under `data/sweeps/`. Saved files include:

- target success rate and random seed;
- every agent and its success count;
- every individual success/failure outcome across every configured game;
- run timestamp and compute duration.
- cost per game, reward per win, and derived profit/loss analysis.

The detailed mode can export its complete result matrix as CSV. The application imposes no configured ceiling on agents, games, total trials, cost, or reward. Positive counts and finite non-negative financial inputs are required; practical capacity is determined by the machine's available memory, disk, and compute time. Large matrices automatically switch to a compact raster renderer.

The visible archive has intentionally been removed from the streamlined interface. The API continues to preserve generated data on disk.

## API

- `POST /api/runs` with `{ "successRate": 0.01, "agentCount": 200, "gamesPerAgent": 300, "gameCost": 1, "winReward": 100 }` creates and saves a run.
- `GET /api/runs` lists saved runs.
- `GET /api/runs/{id}` returns one complete run.
- `DELETE /api/runs/{id}` removes a run from the archive and moves its JSON file to `data/trash/`.
- `POST /api/sweeps` with `{ "agentCount": 200, "gamesPerAgent": 300, "gameCost": 1, "winReward": 100 }` runs and saves all 1,089 probability fields. It returns the first tested probability where `probability × reward − cost > 0` and the smallest attempt count where `1 − (1 − probability)^attempts ≥ 0.90`.
- `GET /api/sweeps/{id}` returns a saved sweep and its aggregate first-success distributions.
- `POST /api/uncertain` with a `{ "mean": …, "uncertainty": …, "metaUncertainty": … }` block per parameter, plus `maxAttempts` and `learningLaw` (`"logit"` or `"ceiling"`), runs the hierarchical model. `worlds` and `universesPerWorld` may be supplied to pin the sampling effort; omit them and the engine sizes itself.
- `GET /api/uncertain/{id}` returns a saved run.
- `GET /api/modes` lists the registered modes.

Each mode also supports `GET`, `GET /{id}` and `DELETE /{id}` on its own path.

The optional `seed` field makes a run exactly reproducible, including the number of worlds the engine chooses for itself. Seeds are parsed as 64-bit integers and survive a round trip exactly.

## Source layout

Adding a mode means writing one `Experiment` and registering it in `Main`; it inherits its four REST routes, its own storage folder, and the shared error handling.

```
src/probexperiment/
  Main.java        assembles the application and registers the modes
  engine/          one file per mode, plus the interface and route wiring
  numeric/         seeded RNG and exact samplers, histograms, rank statistics
  json/            recursive-descent parser and streaming writer
  http/            routing with a single error boundary, static files
  store/           atomic per-mode result storage
```

## Production build

Create a self-contained executable JAR containing both the Java API and frontend:

```powershell
npm run build
java -jar build\probability-field-lab.jar
```

The server reads `PORT`, `HOST`, and `EXPERIMENT_DATA_ROOT` environment variables in hosted environments. Local development continues to work with `npm run dev`.

## Deployment

Pushing to `main` builds the JAR, smoke-tests it, publishes a Docker image to GHCR, then deploys it to the OVH VPS over SSH behind Caddy on `127.0.0.1:8774`, rolling back if the container healthcheck does not go green. See [docs/server-deployment.md](docs/server-deployment.md) for the one-time server setup and the secrets the workflow expects.

The Bicep template in `infra/main.bicep` and [docs/azure-deployment.md](docs/azure-deployment.md) remain for the Azure App Service route.
