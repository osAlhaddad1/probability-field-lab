# Probability Field Lab

A dependency-free Java + JavaScript probability experiment. Each run launches a configurable number of concurrent mini agents, and every agent plays a configurable number of independent probability games. The defaults are **200 agents × 300 games = 60,000 outcomes**. Each game can also have a configurable cost and each success a configurable reward.

## Run it

The recommended development command starts both the Java API and JavaScript frontend:

```powershell
npm run dev
```

Then open the address printed in the terminal. It normally uses [http://localhost:8080](http://localhost:8080); if that port is occupied, the development command automatically selects the next available port. The server stays live until you press `Ctrl+C`.

You can also double-click `run.bat`. Both options compile the project with the installed Java JDK and run the same combined frontend/API server.

## What is saved

Each experiment is stored as a JSON file under `data/runs/`. It includes:

- target success rate and random seed;
- every agent and its success count;
- every individual success/failure outcome across every configured game;
- run timestamp and compute duration.
- cost per game, reward per win, and derived profit/loss analysis.

The dashboard can reopen any saved run and export its complete result matrix as CSV. The UI accepts 1–10,000 agents and 1–10,000 games per agent, with a limit of 10,000,000 total games per run. Large matrices automatically switch to a compact raster renderer.

Saved runs can be deleted from the archive. Deletion is recoverable: files are moved from `data/runs/` to `data/trash/`.

## API

- `POST /api/runs` with `{ "successRate": 0.01, "agentCount": 200, "gamesPerAgent": 300, "gameCost": 1, "winReward": 100 }` creates and saves a run.
- `GET /api/runs` lists saved runs.
- `GET /api/runs/{id}` returns one complete run.
- `DELETE /api/runs/{id}` removes a run from the archive and moves its JSON file to `data/trash/`.

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
