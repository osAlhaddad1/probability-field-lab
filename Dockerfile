# syntax=docker/dockerfile:1

# The build script is Node, the application is Java 21, so the build stage needs
# both. Node is copied in rather than pulled through apt to keep the layer small.
FROM eclipse-temurin:21-jdk AS build
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY package.json ./
COPY scripts ./scripts
COPY src ./src
COPY frontend ./frontend
RUN node scripts/build.mjs

FROM eclipse-temurin:21-jre
RUN apt-get update \
    && apt-get install --no-install-recommends --yes curl \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 10001 --create-home --home-dir /app probability
WORKDIR /app
COPY --from=build /app/build/probability-field-lab.jar ./probability-field-lab.jar
USER 10001

# The frontend is embedded in the JAR; /data is a bind mount owned by uid 10001.
ENV HOST=0.0.0.0 \
    PORT=8080 \
    EXPERIMENT_DATA_ROOT=/data
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:8080/api/health || exit 1

ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-jar", "/app/probability-field-lab.jar"]
