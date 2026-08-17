# Probability Field Lab

A dependency-free Java + JavaScript probability experiment. Each run launches a configurable number of concurrent mini agents, and every agent plays a configurable number of independent probability games. The defaults are **200 agents × 300 games = 60,000 outcomes**. Each game can also have a configurable cost and each success a configurable reward.

The dashboard has two modes:

- **Known odds** runs one detailed field at a chosen success probability.
- **Unknown odds** repeats the complete field 1,089 times: 0.01%–1.00% in 0.01% steps, then 1.1%–99.9% in 0.1% steps. It builds a ten-graph decision atlas around profit, risk, waiting time, and automatic move-on boundaries. Graph 01 includes an interactive deadline planner for either a concrete net-profit target or a realized ROI target from 1%–500%.

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

The optional `seed` field makes a run exactly reproducible.

## Production build

Create a self-contained executable JAR containing both the Java API and frontend:

```powershell
npm run build
java -jar build\probability-field-lab.jar
```

The server reads `PORT`, `HOST`, and `EXPERIMENT_DATA_ROOT` environment variables in hosted environments. Local development continues to work with `npm run dev`.

## GitHub and Azure

The repository includes a GitHub Actions workflow and Bicep infrastructure for passwordless deployment to Azure App Service. See [docs/azure-deployment.md](docs/azure-deployment.md) for the one-time Azure student-account setup and deployment commands.
