const $ = (selector) => document.querySelector(selector);
const rateNumber = $('#rate-number');
const rateSlider = $('#rate-slider');
const agentCountInput = $('#agent-count');
const gameCountInput = $('#game-count');
const gameCostInput = $('#game-cost');
const winRewardInput = $('#win-reward');
const totalGamesOutput = $('#total-games');
const workloadWarning = $('#workload-warning');
const runButton = $('#run-button');
const resultsSection = $('#results');
const sweepResultsSection = $('#sweep-results');
const fixedRatePanel = $('#fixed-rate-panel');
const sweepRatePanel = $('#sweep-rate-panel');
const matrix = $('#matrix');
const tooltip = $('#tooltip');
const chartTooltip = $('#chart-tooltip');
let currentRun = null;
let currentSweep = null;
let experimentMode = 'fixed';
const sweepState = { selectedProbability: 25, confidence: .9 };
const MAX_TOTAL_GAMES = 10000000;
let matrixCell = 7;
const chartModels = {};
let pinnedChart = null;
const WAIT_PAD = { left: 55, right: 55, top: 24, bottom: 36 };
const waitingState = {
  runId: null,
  metric: 'count',
  scale: 'linear',
  layers: { expected: true, cumulative: true, survival: false, percentiles: true },
  selection: null,
  view: null,
  dragging: false,
  dragOrigin: null,
  hoverIndex: null
};
let waitingData = null;

function clampRate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : 1;
}

function setRate(value) {
  const rate = clampRate(value);
  rateNumber.value = rate;
  rateSlider.value = rate;
  rateSlider.style.setProperty('--progress', `${rate}%`);
}

rateNumber.addEventListener('input', () => setRate(rateNumber.value));
rateSlider.addEventListener('input', () => setRate(rateSlider.value));
setRate(1);

function integerValue(input, fallback) {
  const value = Math.floor(Number(input.value));
  return Number.isFinite(value) ? value : fallback;
}

function financialValue(input, fallback) {
  const value = Number(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function updateWorkload() {
  const agents = integerValue(agentCountInput, 200);
  const games = integerValue(gameCountInput, 300);
  const gameCost = financialValue(gameCostInput, 1);
  const winReward = financialValue(winRewardInput, 100);
  const multiplier = experimentMode === 'sweep' ? 99 : 1;
  const total = agents * games * multiplier;
  totalGamesOutput.textContent = Number.isFinite(total) ? total.toLocaleString() : '—';
  $('#total-games-label').textContent = experimentMode === 'sweep' ? 'TOTAL GAMES · 99 FIELDS' : 'TOTAL GAMES';
  runButton.querySelector('.button-label').textContent = experimentMode === 'sweep' ? 'RUN 1—99% SWEEP' : 'RUN EXPERIMENT';
  const invalidEconomics = gameCost < 0 || gameCost > 1000000000 || winReward < 0 || winReward > 1000000000;
  const invalid = agents < 1 || agents > 10000 || games < 1 || games > 10000 || total > MAX_TOTAL_GAMES || invalidEconomics;
  workloadWarning.classList.toggle('invalid', invalid);
  workloadWarning.textContent = total > MAX_TOTAL_GAMES
    ? `${total.toLocaleString()} EXCEEDS THE 10,000,000 LIMIT`
    : invalidEconomics
      ? 'COST AND REWARD MUST BE BETWEEN 0 AND 1,000,000,000'
      : experimentMode === 'sweep'
        ? '99 PROBABILITIES · MAXIMUM 10,000,000 TOTAL GAMES'
        : 'MAXIMUM 10,000,000 TOTAL GAMES';
  runButton.disabled = invalid;
  return { agents, games, gameCost, winReward, total, invalid };
}

agentCountInput.addEventListener('input', updateWorkload);
gameCountInput.addEventListener('input', updateWorkload);
gameCostInput.addEventListener('input', updateWorkload);
winRewardInput.addEventListener('input', updateWorkload);
updateWorkload();

function setExperimentMode(mode) {
  experimentMode = mode === 'sweep' ? 'sweep' : 'fixed';
  document.querySelectorAll('[data-mode]').forEach(button => {
    const active = button.dataset.mode === experimentMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  fixedRatePanel.classList.toggle('hidden', experimentMode === 'sweep');
  sweepRatePanel.classList.toggle('hidden', experimentMode !== 'sweep');
  updateWorkload();
}

document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => setExperimentMode(button.dataset.mode)));

runButton.addEventListener('click', async () => {
  const workload = updateWorkload();
  if (workload.invalid) return;
  runButton.disabled = true;
  runButton.classList.add('loading');
  try {
    const response = await fetch(experimentMode === 'sweep' ? '/api/sweeps' : '/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(experimentMode === 'fixed' ? { successRate: clampRate(rateNumber.value) / 100 } : {}),
        agentCount: workload.agents,
        gamesPerAgent: workload.games,
        gameCost: workload.gameCost,
        winReward: workload.winReward
      })
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Experiment failed');
    const payload = await response.json();
    if (experimentMode === 'sweep') {
      showSweep(payload);
      sweepResultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      showRun(payload);
      resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (error) {
    alert(`Could not run experiment: ${error.message}`);
  } finally {
    updateWorkload();
    runButton.classList.remove('loading');
  }
});

function showRun(run) {
  currentRun = run;
  currentSweep = null;
  pinnedChart = null;
  chartTooltip.classList.remove('visible');
  agentCountInput.value = run.agentCount;
  gameCountInput.value = run.gamesPerAgent;
  run.gameCost = run.gameCost ?? 1;
  run.winReward = run.winReward ?? 100;
  gameCostInput.value = run.gameCost;
  winRewardInput.value = run.winReward;
  updateWorkload();
  resultsSection.classList.remove('hidden');
  sweepResultsSection.classList.add('hidden');
  const successes = run.totalSuccesses;
  const failures = run.totalGames - successes;
  const actualPercent = successes / run.totalGames * 100;
  $('#success-count').textContent = successes.toLocaleString();
  $('#success-percent').textContent = `${actualPercent.toFixed(3)}% ACTUAL RATE`;
  $('#failure-count').textContent = failures.toLocaleString();
  $('#failure-percent').textContent = `${(100 - actualPercent).toFixed(3)}% ACTUAL RATE`;
  $('#expected-count').textContent = Math.round(run.totalGames * run.successRate).toLocaleString();
  $('#duration').textContent = `${run.durationMs} ms`;
  $('#run-meta').textContent = `${new Date(run.createdAt).toLocaleString()}  /  SEED ${run.seed}`;
  $('#matrix-axis-x').textContent = `PROBABILITY GAMES 001—${String(run.gamesPerAgent).padStart(3, '0')} →`;
  matrix.setAttribute('aria-label', `Experiment result table with ${run.agentCount} agents in rows and ${run.gamesPerAgent} games in columns`);
  drawMatrix(run);
  drawAnalytics(run);
}

function drawMatrix(run) {
  const totalCells = run.agentCount * run.gamesPerAgent;
  matrixCell = totalCells > 2000000 ? 1 : totalCells > 500000 ? 2 : totalCells > 150000 ? 4 : 7;
  const dpr = matrixCell <= 2 ? 1 : Math.min(window.devicePixelRatio || 1, 1.5);
  const labelWidth = 64;
  const headerHeight = 34;
  const cell = matrixCell;
  const width = labelWidth + run.gamesPerAgent * cell;
  const height = headerHeight + run.agentCount * cell;
  matrix.width = width * dpr;
  matrix.height = height * dpr;
  matrix.style.width = `${width}px`;
  matrix.style.height = `${height}px`;
  const ctx = matrix.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#fbfbf7';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#e7e8de';
  ctx.fillRect(0, 0, width, headerHeight);
  ctx.fillRect(0, 0, labelWidth, height);
  ctx.font = '9px "DM Mono", monospace';
  ctx.fillStyle = '#14251d';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const columnStep = Math.max(1, Math.ceil(58 / cell));
  const rowStep = Math.max(1, Math.ceil(34 / cell));
  for (let game = 0; game < run.gamesPerAgent; game += columnStep) {
    ctx.save();
    ctx.translate(labelWidth + game * cell + cell / 2, headerHeight - 6);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(String(game + 1).padStart(3, '0'), 0, 0);
    ctx.restore();
  }
  run.agents.forEach((agent, row) => {
    if (row % rowStep === 0) {
      ctx.fillStyle = '#435148';
      ctx.textAlign = 'right';
      ctx.fillText(`A-${String(agent.id).padStart(3, '0')}`, labelWidth - 8, headerHeight + row * cell + cell / 2);
    }
  });

  if (totalCells > 150000) {
    const raster = document.createElement('canvas');
    raster.width = run.gamesPerAgent;
    raster.height = run.agentCount;
    const rasterContext = raster.getContext('2d');
    const image = rasterContext.createImageData(run.gamesPerAgent, run.agentCount);
    let pixel = 0;
    for (const agent of run.agents) {
      for (let column = 0; column < run.gamesPerAgent; column++) {
        const success = agent.outcomes[column] === '1';
        image.data[pixel++] = success ? 22 : 251;
        image.data[pixel++] = success ? 160 : 251;
        image.data[pixel++] = success ? 93 : 247;
        image.data[pixel++] = 255;
      }
    }
    rasterContext.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(raster, labelWidth, headerHeight, run.gamesPerAgent * cell, run.agentCount * cell);
  } else {
    run.agents.forEach((agent, row) => {
      for (let column = 0; column < run.gamesPerAgent; column++) {
        const x = labelWidth + column * cell;
        const y = headerHeight + row * cell;
        ctx.fillStyle = agent.outcomes[column] === '1' ? '#16a05d' : '#fbfbf7';
        ctx.fillRect(x + .5, y + .5, Math.max(1, cell - 1), Math.max(1, cell - 1));
      }
    });
  }
  ctx.strokeStyle = '#d3d7cf';
  ctx.lineWidth = 1;
  for (let row = 0; row <= run.agentCount; row += Math.max(rowStep, Math.ceil(50 / cell))) {
    const y = headerHeight + row * cell + .5;
    ctx.beginPath(); ctx.moveTo(labelWidth, y); ctx.lineTo(width, y); ctx.stroke();
  }
  for (let column = 0; column <= run.gamesPerAgent; column += columnStep) {
    const x = labelWidth + column * cell + .5;
    ctx.beginPath(); ctx.moveTo(x, headerHeight); ctx.lineTo(x, height); ctx.stroke();
  }
}

matrix.addEventListener('mousemove', (event) => {
  if (!currentRun) return;
  const rect = matrix.getBoundingClientRect();
  const scaleX = matrix.clientWidth / rect.width;
  const scaleY = matrix.clientHeight / rect.height;
  const x = (event.clientX - rect.left) * scaleX;
  const y = (event.clientY - rect.top) * scaleY;
  const row = Math.floor((y - 34) / matrixCell);
  const column = Math.floor((x - 64) / matrixCell);
  if (row < 0 || row >= currentRun.agentCount || column < 0 || column >= currentRun.gamesPerAgent) {
    tooltip.classList.remove('visible'); return;
  }
  const success = currentRun.agents[row].outcomes[column] === '1';
  tooltip.innerHTML = `AGENT ${String(row + 1).padStart(3, '0')}<br>GAME ${String(column + 1).padStart(3, '0')} · ${success ? 'SUCCESS' : 'FAILURE'}`;
  tooltip.style.left = `${event.clientX + 16}px`;
  tooltip.style.top = `${event.clientY + 16}px`;
  tooltip.classList.add('visible');
});
matrix.addEventListener('mouseleave', () => tooltip.classList.remove('visible'));

function getChartContext(id, dark = false) {
  const canvas = document.getElementById(id);
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(280, Math.floor(rect.width));
  const height = Math.max(210, Math.floor(rect.height));
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);
  return {
    ctx, width, height,
    ink: dark ? '#fbfbf7' : '#14251d',
    muted: dark ? '#65736a' : '#aeb5ac',
    green: dark ? '#d6f25c' : '#16a05d',
    pad: { left: 43, right: 13, top: 15, bottom: 29 }
  };
}

function chartFrame(chart, yTicks, yFormatter = value => value, xLabels = ['001', '300']) {
  const { ctx, width, height, ink, muted, pad } = chart;
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  ctx.font = '9px "DM Mono", monospace';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  yTicks.forEach(({ value, ratio }) => {
    const y = pad.top + plotHeight * (1 - ratio) + .5;
    ctx.strokeStyle = muted;
    ctx.globalAlpha = .35;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    ctx.globalAlpha = .75;
    ctx.fillStyle = ink;
    ctx.textAlign = 'right';
    ctx.fillText(yFormatter(value), pad.left - 8, y);
  });
  ctx.globalAlpha = .75;
  ctx.textAlign = 'left';
  ctx.fillStyle = ink;
  ctx.fillText(xLabels[0], pad.left, height - 9);
  ctx.textAlign = 'right';
  ctx.fillText(xLabels[1], width - pad.right, height - 9);
  ctx.globalAlpha = 1;
  return { plotWidth, plotHeight };
}

function drawAnalytics(run) {
  drawConvergence(run);
  drawGamePulse(run);
  drawDistribution(run);
  drawRanking(run);
  drawFirstSuccess(run);
  drawFinancials(run);
}

function drawConvergence(run) {
  const chart = getChartContext('convergence-chart');
  const { ctx, width, height, ink, green, pad } = chart;
  const cumulativeRates = [];
  let cumulative = 0;
  for (let game = 0; game < run.gamesPerAgent; game++) {
    for (const agent of run.agents) cumulative += Number(agent.outcomes[game]);
    cumulativeRates.push(cumulative / ((game + 1) * run.agentCount) * 100);
  }
  const target = run.successRate * 100;
  const maxValue = Math.max(target, ...cumulativeRates, .1) * 1.18;
  const ticks = [0, .5, 1].map(ratio => ({ value: maxValue * ratio, ratio }));
  const { plotWidth, plotHeight } = chartFrame(chart, ticks, value => `${value.toFixed(1)}%`, ['001', String(run.gamesPerAgent).padStart(3, '0')]);
  const x = index => pad.left + index / Math.max(1, run.gamesPerAgent - 1) * plotWidth;
  const y = value => pad.top + plotHeight * (1 - value / maxValue);
  ctx.strokeStyle = '#7c877f';
  ctx.setLineDash([5, 5]);
  ctx.beginPath(); ctx.moveTo(pad.left, y(target)); ctx.lineTo(width - pad.right, y(target)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = green;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  cumulativeRates.forEach((value, index) => index ? ctx.lineTo(x(index), y(value)) : ctx.moveTo(x(index), y(value)));
  ctx.stroke();
  const finalRate = cumulativeRates.at(-1);
  ctx.fillStyle = green;
  const lastGame = run.gamesPerAgent - 1;
  ctx.beginPath(); ctx.arc(x(lastGame), y(finalRate), 4, 0, Math.PI * 2); ctx.fill();
  ctx.font = '9px "DM Mono", monospace';
  ctx.fillStyle = ink; ctx.textAlign = 'right';
  ctx.fillText(`${finalRate.toFixed(3)}%`, x(lastGame) - 8, y(finalRate) - 10);
  const deviation = Math.abs(finalRate - target);
  $('#convergence-insight').textContent = `FINAL GAP ${deviation.toFixed(3)} PTS`;
  chartModels['convergence-chart'] = {
    count: run.gamesPerAgent,
    describe: index => {
      const trials = (index + 1) * run.agentCount;
      const successes = Math.round(cumulativeRates[index] / 100 * trials);
      return `<strong>GAME ${index + 1}</strong><br>Observed cumulative rate: ${cumulativeRates[index].toFixed(3)}%<br>Target rate: ${target.toFixed(3)}%<br>${successes.toLocaleString()} successes / ${trials.toLocaleString()} trials`;
    }
  };
}

function drawGamePulse(run) {
  const chart = getChartContext('game-chart', true);
  const { ctx, width, height, green, pad } = chart;
  const counts = Array.from({ length: run.gamesPerAgent }, (_, game) =>
    run.agents.reduce((sum, agent) => sum + Number(agent.outcomes[game]), 0));
  const max = Math.max(...counts, 1);
  const ticks = [0, Math.ceil(max / 2), max].map(value => ({ value, ratio: value / max }));
  const { plotWidth, plotHeight } = chartFrame(chart, ticks, value => value, ['001', String(run.gamesPerAgent).padStart(3, '0')]);
  const barWidth = plotWidth / counts.length;
  counts.forEach((value, index) => {
    const barHeight = value / max * plotHeight;
    ctx.fillStyle = value === max ? '#d6f25c' : green;
    ctx.globalAlpha = value === 0 ? .18 : .8;
    ctx.fillRect(pad.left + index * barWidth, pad.top + plotHeight - barHeight, Math.max(1, barWidth), barHeight);
  });
  ctx.globalAlpha = 1;
  const peakGame = counts.indexOf(max) + 1;
  $('#game-insight').textContent = `PEAK GAME ${String(peakGame).padStart(3, '0')} / ${max} SUCCESSES`;
  chartModels['game-chart'] = {
    count: run.gamesPerAgent,
    describe: index => `<strong>GAME ${index + 1}</strong><br>${counts[index]} successes / ${run.agentCount} agents<br>${(counts[index] / run.agentCount * 100).toFixed(2)}% observed rate<br>${run.agentCount - counts[index]} failures`
  };
}

function drawDistribution(run) {
  const chart = getChartContext('distribution-chart');
  const { ctx, width, height, green, ink, pad } = chart;
  const totals = run.agents.map(agent => agent.successes);
  const maxTotal = Math.max(...totals, 1);
  const frequencies = Array(maxTotal + 1).fill(0);
  totals.forEach(total => frequencies[total]++);
  const maxFrequency = Math.max(...frequencies, 1);
  const ticks = [0, Math.ceil(maxFrequency / 2), maxFrequency].map(value => ({ value, ratio: value / maxFrequency }));
  const { plotWidth, plotHeight } = chartFrame(chart, ticks, value => value, ['', '']);
  const slot = plotWidth / frequencies.length;
  const labelStep = Math.max(1, Math.ceil(14 / slot));
  frequencies.forEach((frequency, successes) => {
    const barHeight = frequency / maxFrequency * plotHeight;
    ctx.fillStyle = successes === Math.round(run.gamesPerAgent * run.successRate) ? '#d6f25c' : green;
    ctx.fillRect(pad.left + successes * slot + .5, pad.top + plotHeight - barHeight, Math.max(1, slot - 1), barHeight);
    if (successes % labelStep === 0 || successes === frequencies.length - 1) {
      ctx.fillStyle = ink;
      ctx.font = '8px "DM Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(String(successes), pad.left + successes * slot + slot / 2, height - 9);
    }
  });
  const mode = frequencies.indexOf(maxFrequency);
  $('#distribution-insight').textContent = `MODE ${mode} / ${frequencies[0]} AGENTS AT ZERO`;
  chartModels['distribution-chart'] = {
    count: frequencies.length,
    describe: index => `<strong>${index} SUCCESS${index === 1 ? '' : 'ES'} PER AGENT</strong><br>${frequencies[index]} agents<br>${(frequencies[index] / run.agentCount * 100).toFixed(2)}% of the agent field`
  };
}

function drawRanking(run) {
  const chart = getChartContext('ranking-chart');
  const { ctx, width, height, green, ink, pad } = chart;
  const ranked = run.agents.map(agent => ({ id: agent.id, successes: agent.successes })).sort((a, b) => b.successes - a.successes || a.id - b.id);
  const max = Math.max(...ranked.map(agent => agent.successes), 1);
  const ticks = [0, Math.ceil(max / 2), max].map(value => ({ value, ratio: value / max }));
  const { plotWidth, plotHeight } = chartFrame(chart, ticks, value => value, ['RANK 1', `RANK ${run.agentCount}`]);
  const barWidth = plotWidth / ranked.length;
  ranked.forEach((agent, index) => {
    const barHeight = agent.successes / max * plotHeight;
    ctx.fillStyle = index < 10 ? ink : green;
    ctx.globalAlpha = index < 10 ? 1 : .78;
    ctx.fillRect(pad.left + index * barWidth, pad.top + plotHeight - barHeight, Math.max(1, barWidth - .35), barHeight);
  });
  ctx.globalAlpha = 1;
  const middle = Math.floor(ranked.length / 2);
  const median = ranked.length % 2
    ? ranked[middle].successes
    : (ranked[middle - 1].successes + ranked[middle].successes) / 2;
  $('#ranking-insight').textContent = `RANGE ${ranked.at(-1).successes}—${ranked[0].successes} / MEDIAN ${median.toFixed(1)}`;
  chartModels['ranking-chart'] = {
    count: ranked.length,
    describe: index => `<strong>RANK ${index + 1} / AGENT ${ranked[index].id}</strong><br>${ranked[index].successes} successes<br>${(ranked[index].successes / run.gamesPerAgent * 100).toFixed(3)}% personal success rate`
  };
}

function waitingBucketLabel(index, run, prefix = true) {
  if (index === run.gamesPerAgent) return 'NO SUCCESS';
  return `${prefix ? 'GAME ' : ''}${index + 1}`;
}

function percentile(sortedValues, probability) {
  if (!sortedValues.length) return null;
  return sortedValues[Math.max(0, Math.ceil(sortedValues.length * probability) - 1)];
}

function updateWaitingControls() {
  document.querySelectorAll('[data-wait-metric]').forEach(button => {
    const active = button.dataset.waitMetric === waitingState.metric;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('[data-wait-scale]').forEach(button => {
    const active = button.dataset.waitScale === waitingState.scale;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('[data-wait-layer]').forEach(button => {
    const active = waitingState.layers[button.dataset.waitLayer];
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const zoomButton = $('#waiting-zoom');
  const selection = waitingState.selection;
  const view = waitingState.view;
  zoomButton.disabled = !selection || (view && selection[0] === view[0] && selection[1] === view[1]);
}

function updateWaitingSelection(data) {
  if (!data) return;
  const { run, counts, expected } = data;
  const range = waitingState.selection || waitingState.view || [0, run.gamesPerAgent];
  const [start, end] = range;
  const fullRange = start === 0 && end === run.gamesPerAgent;
  const rangeText = fullRange && !waitingState.selection
    ? 'ALL GAMES'
    : start === end
      ? waitingBucketLabel(start, run)
      : `${waitingBucketLabel(start, run)} — ${waitingBucketLabel(end, run)}`;
  const agents = counts.slice(start, end + 1).reduce((sum, value) => sum + value, 0);
  const expectedAgents = expected.slice(start, end + 1).reduce((sum, value) => sum + value, 0);
  let successfulAgents = 0;
  let weightedWait = 0;
  for (let index = start; index <= Math.min(end, run.gamesPerAgent - 1); index++) {
    successfulAgents += counts[index];
    weightedWait += counts[index] * (index + 1);
  }
  const orderValue = order => {
    let seen = 0;
    for (let index = start; index <= Math.min(end, run.gamesPerAgent - 1); index++) {
      seen += counts[index];
      if (seen >= order) return index + 1;
    }
    return null;
  };
  const median = !successfulAgents ? null : successfulAgents % 2
    ? orderValue((successfulAgents + 1) / 2)
    : (orderValue(successfulAgents / 2) + orderValue(successfulAgents / 2 + 1)) / 2;
  const delta = agents - expectedAgents;

  $('#waiting-range').textContent = rangeText;
  $('#waiting-agents').textContent = agents.toLocaleString();
  $('#waiting-share').textContent = `${(agents / run.agentCount * 100).toFixed(2)}%`;
  $('#waiting-expected').textContent = expectedAgents.toFixed(2);
  $('#waiting-delta').textContent = `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`;
  $('#waiting-average').textContent = successfulAgents ? `${(weightedWait / successfulAgents).toFixed(2)} G` : '—';
  $('#waiting-median').textContent = median === null ? '—' : `${median.toFixed(1)} G`;
  $('#waiting-view-label').textContent = waitingState.view && !(waitingState.view[0] === 0 && waitingState.view[1] === run.gamesPerAgent)
    ? `VIEW ${waitingBucketLabel(waitingState.view[0], run)} — ${waitingBucketLabel(waitingState.view[1], run)}`
    : 'VIEWING ALL GAMES';
  updateWaitingControls();
}

function drawFirstSuccess(run) {
  if (waitingState.runId !== run.id) {
    waitingState.runId = run.id;
    waitingState.selection = null;
    waitingState.view = [0, run.gamesPerAgent];
    waitingState.dragging = false;
    waitingState.hoverIndex = null;
  }

  const chart = getChartContext('first-success-chart');
  chart.pad = WAIT_PAD;
  const { ctx, width, height, green, ink, muted, pad } = chart;
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const bucketCount = run.gamesPerAgent + 1;
  const counts = Array(bucketCount).fill(0);
  const firstSuccessGames = [];

  run.agents.forEach(agent => {
    const firstIndex = agent.outcomes.indexOf('1');
    if (firstIndex === -1) counts[run.gamesPerAgent]++;
    else {
      counts[firstIndex]++;
      firstSuccessGames.push(firstIndex + 1);
    }
  });
  firstSuccessGames.sort((a, b) => a - b);

  const probability = run.successRate;
  const expected = Array.from({ length: run.gamesPerAgent }, (_, index) =>
    run.agentCount * Math.pow(1 - probability, index) * probability);
  expected.push(run.agentCount * Math.pow(1 - probability, run.gamesPerAgent));

  const cumulative = [];
  let achieved = 0;
  for (let index = 0; index < run.gamesPerAgent; index++) {
    achieved += counts[index];
    cumulative.push(achieved / run.agentCount * 100);
  }
  cumulative.push(achieved / run.agentCount * 100);
  const survival = cumulative.map(value => 100 - value);

  const [viewStart, viewEnd] = waitingState.view || [0, run.gamesPerAgent];
  const visibleCount = viewEnd - viewStart + 1;
  const slot = plotWidth / visibleCount;
  const metricValue = value => waitingState.metric === 'percent' ? value / run.agentCount * 100 : value;
  const visibleObserved = counts.slice(viewStart, viewEnd + 1).map(metricValue);
  const visibleExpected = expected.slice(viewStart, viewEnd + 1).map(metricValue);
  const rawMax = Math.max(...visibleObserved, ...(waitingState.layers.expected ? visibleExpected : []), waitingState.metric === 'percent' ? .01 : 1);
  const max = waitingState.scale === 'log' ? rawMax : Math.ceil(rawMax * 1.08);
  const yRatio = value => waitingState.scale === 'log'
    ? Math.log1p(value) / Math.log1p(Math.max(max, .0001))
    : value / Math.max(max, .0001);
  const y = value => pad.top + plotHeight * (1 - yRatio(value));
  const x = index => pad.left + (index - viewStart + .5) * slot;
  const xBoundary = index => pad.left + (index - viewStart) * slot;

  ctx.font = '9px "DM Mono", monospace';
  ctx.textBaseline = 'middle';
  const tickRatios = [0, .5, 1];
  tickRatios.forEach(ratio => {
    const value = waitingState.scale === 'log'
      ? Math.expm1(Math.log1p(max) * ratio)
      : max * ratio;
    const tickY = pad.top + plotHeight * (1 - ratio) + .5;
    ctx.strokeStyle = muted;
    ctx.globalAlpha = .42;
    ctx.beginPath(); ctx.moveTo(pad.left, tickY); ctx.lineTo(width - pad.right, tickY); ctx.stroke();
    ctx.globalAlpha = .8;
    ctx.fillStyle = ink;
    ctx.textAlign = 'right';
    const label = waitingState.metric === 'percent' ? `${value.toFixed(value < 10 ? 1 : 0)}%` : value.toFixed(value < 10 ? 1 : 0);
    ctx.fillText(label, pad.left - 8, tickY);
  });

  if (waitingState.layers.cumulative || waitingState.layers.survival) {
    ctx.textAlign = 'left';
    ctx.fillStyle = ink;
    ctx.globalAlpha = .7;
    ctx.fillText('100%', width - pad.right + 7, pad.top);
    ctx.fillText('50%', width - pad.right + 7, pad.top + plotHeight / 2);
    ctx.fillText('0%', width - pad.right + 7, pad.top + plotHeight);
  }

  if (waitingState.selection) {
    const selectionStart = Math.max(viewStart, waitingState.selection[0]);
    const selectionEnd = Math.min(viewEnd, waitingState.selection[1]);
    if (selectionStart <= selectionEnd) {
      const left = xBoundary(selectionStart);
      const right = xBoundary(selectionEnd + 1);
      ctx.fillStyle = '#d6f25c';
      ctx.globalAlpha = .26;
      ctx.fillRect(left, pad.top, right - left, plotHeight);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(left, pad.top); ctx.lineTo(left, pad.top + plotHeight); ctx.moveTo(right, pad.top); ctx.lineTo(right, pad.top + plotHeight); ctx.stroke();
    }
  }

  for (let index = viewStart; index <= viewEnd; index++) {
    const value = metricValue(counts[index]);
    const barHeight = Math.max(0, pad.top + plotHeight - y(value));
    ctx.fillStyle = index === run.gamesPerAgent ? ink : green;
    ctx.globalAlpha = index === run.gamesPerAgent ? 1 : .76;
    ctx.fillRect(xBoundary(index) + .35, pad.top + plotHeight - barHeight, Math.max(1, slot - .7), barHeight);
  }
  ctx.globalAlpha = 1;

  if (waitingState.layers.expected) {
    ctx.strokeStyle = '#68766d';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    for (let index = viewStart; index <= viewEnd; index++) {
      const pointY = y(metricValue(expected[index]));
      index === viewStart ? ctx.moveTo(x(index), pointY) : ctx.lineTo(x(index), pointY);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const drawPercentLayer = (values, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let index = viewStart; index <= viewEnd; index++) {
      const pointY = pad.top + plotHeight * (1 - values[index] / 100);
      index === viewStart ? ctx.moveTo(x(index), pointY) : ctx.lineTo(x(index), pointY);
    }
    ctx.stroke();
  };
  if (waitingState.layers.cumulative) drawPercentLayer(cumulative, '#08713d');
  if (waitingState.layers.survival) drawPercentLayer(survival, '#a74d32');

  if (waitingState.layers.percentiles && firstSuccessGames.length) {
    [
      ['P50', percentile(firstSuccessGames, .5)],
      ['P75', percentile(firstSuccessGames, .75)],
      ['P90', percentile(firstSuccessGames, .9)]
    ].forEach(([label, game], markerIndex) => {
      const index = game - 1;
      if (index < viewStart || index > viewEnd) return;
      const markerX = x(index);
      ctx.strokeStyle = ink;
      ctx.globalAlpha = .45;
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(markerX, pad.top); ctx.lineTo(markerX, pad.top + plotHeight); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.fillStyle = ink;
      ctx.textAlign = 'center';
      ctx.fillText(`${label} · G${game}`, markerX, pad.top + 8 + markerIndex * 11);
    });
  }

  if (waitingState.hoverIndex !== null && waitingState.hoverIndex >= viewStart && waitingState.hoverIndex <= viewEnd) {
    const guideX = x(waitingState.hoverIndex);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1;
    ctx.globalAlpha = .75;
    ctx.beginPath(); ctx.moveTo(guideX, pad.top); ctx.lineTo(guideX, pad.top + plotHeight); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  ctx.fillStyle = ink;
  ctx.globalAlpha = .8;
  ctx.textAlign = 'left';
  ctx.fillText(waitingBucketLabel(viewStart, run), pad.left, height - 11);
  ctx.textAlign = 'right';
  ctx.fillText(waitingBucketLabel(viewEnd, run), width - pad.right, height - 11);
  ctx.globalAlpha = 1;

  waitingData = { run, counts, expected, cumulative, survival, firstSuccessGames, viewStart, viewEnd, slot };
  updateWaitingSelection(waitingData);

  const median = percentile(firstSuccessGames, .5);
  const p90 = percentile(firstSuccessGames, .9);
  const neverCount = counts.at(-1);
  $('#first-success-insight').textContent = median === null
    ? `NO AGENT SUCCEEDED / ${neverCount} NEVER`
    : `P50 ${median}G / P90 ${p90}G / ${neverCount} NEVER`;
}

function formatFinancial(value, digits = 2) {
  if (!Number.isFinite(value)) return '∞';
  const absolute = Math.abs(value);
  if (absolute >= 1000000000) return `${(value / 1000000000).toFixed(2)}B`;
  if (absolute >= 1000000) return `${(value / 1000000).toFixed(2)}M`;
  if (absolute >= 10000) return `${(value / 1000).toFixed(2)}K`;
  return value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: Math.abs(value) < 100 ? Math.min(2, digits) : 0 });
}

function signedFrame(chart, minimum, maximum, xLabels) {
  const { ctx, width, height, ink, muted } = chart;
  const pad = { left: 57, right: 16, top: 15, bottom: 29 };
  let domainMin = Math.min(0, minimum);
  let domainMax = Math.max(0, maximum);
  if (domainMin === domainMax) domainMax = domainMin + 1;
  const padding = (domainMax - domainMin) * .08;
  if (domainMin < 0) domainMin -= padding;
  if (domainMax > 0) domainMax += padding;
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const y = value => pad.top + plotHeight * (1 - (value - domainMin) / (domainMax - domainMin));
  ctx.font = '9px "DM Mono", monospace';
  ctx.textBaseline = 'middle';
  const tickValues = [domainMin, 0, domainMax].filter((value, index, values) => index === 0 || Math.abs(value - values[index - 1]) > 1e-9);
  tickValues.forEach(value => {
    const tickY = y(value) + .5;
    ctx.strokeStyle = value === 0 ? ink : muted;
    ctx.globalAlpha = value === 0 ? .65 : .35;
    ctx.beginPath(); ctx.moveTo(pad.left, tickY); ctx.lineTo(width - pad.right, tickY); ctx.stroke();
    ctx.globalAlpha = .78;
    ctx.fillStyle = ink;
    ctx.textAlign = 'right';
    ctx.fillText(formatFinancial(value, 1), pad.left - 8, tickY);
  });
  ctx.globalAlpha = .75;
  ctx.fillStyle = ink;
  ctx.textAlign = 'left'; ctx.fillText(xLabels[0], pad.left, height - 9);
  ctx.textAlign = 'right'; ctx.fillText(xLabels[1], width - pad.right, height - 9);
  ctx.globalAlpha = 1;
  return { pad, plotWidth, plotHeight, y, domainMin, domainMax };
}

function updateFinancialStats(run) {
  const totalCost = run.totalGames * run.gameCost;
  const grossReward = run.totalSuccesses * run.winReward;
  const net = grossReward - totalCost;
  const roi = totalCost === 0 ? (net > 0 ? Infinity : 0) : net / totalCost * 100;
  const breakEven = run.winReward > 0 ? run.gameCost / run.winReward * 100 : run.gameCost === 0 ? 0 : Infinity;
  $('#finance-cost').textContent = formatFinancial(totalCost);
  $('#finance-reward').textContent = formatFinancial(grossReward);
  $('#finance-net').textContent = `${net >= 0 ? '+' : ''}${formatFinancial(net)}`;
  $('#finance-roi').textContent = `${roi >= 0 && Number.isFinite(roi) ? '+' : ''}${formatFinancial(roi)}%`;
  $('#finance-breakeven').textContent = Number.isFinite(breakEven) ? `${breakEven.toFixed(3)}%` : 'IMPOSSIBLE';
  $('#finance-net').classList.toggle('positive', net >= 0);
  $('#finance-net').classList.toggle('negative', net < 0);
  $('#finance-roi').classList.toggle('positive', roi >= 0);
  $('#finance-roi').classList.toggle('negative', roi < 0);
}

function drawFinancials(run) {
  updateFinancialStats(run);
  drawCumulativePnl(run);
  drawAgentProfit(run);
  drawSensitivity(run);
}

function drawCumulativePnl(run) {
  const chart = getChartContext('pnl-chart', true);
  const { ctx, width, ink } = chart;
  const observed = [];
  const expected = [];
  const successes = [];
  let cumulativeSuccesses = 0;
  for (let game = 0; game < run.gamesPerAgent; game++) {
    for (const agent of run.agents) cumulativeSuccesses += Number(agent.outcomes[game]);
    const trials = (game + 1) * run.agentCount;
    successes.push(cumulativeSuccesses);
    observed.push(cumulativeSuccesses * run.winReward - trials * run.gameCost);
    expected.push(trials * (run.successRate * run.winReward - run.gameCost));
  }
  const values = [...observed, ...expected];
  const frame = signedFrame(chart, Math.min(...values), Math.max(...values), ['GAME 1', `GAME ${run.gamesPerAgent}`]);
  const x = index => frame.pad.left + index / Math.max(1, run.gamesPerAgent - 1) * frame.plotWidth;
  const drawLine = (series, color, dashed = false) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = dashed ? 1.5 : 2.5;
    ctx.setLineDash(dashed ? [5, 5] : []);
    ctx.beginPath();
    series.forEach((value, index) => index ? ctx.lineTo(x(index), frame.y(value)) : ctx.moveTo(x(index), frame.y(value)));
    ctx.stroke();
    ctx.setLineDash([]);
  };
  drawLine(expected, '#8b978f', true);
  drawLine(observed, '#d6f25c');
  const final = observed.at(-1);
  ctx.fillStyle = '#d6f25c';
  ctx.beginPath(); ctx.arc(x(observed.length - 1), frame.y(final), 4, 0, Math.PI * 2); ctx.fill();
  ctx.font = '9px "DM Mono", monospace';
  ctx.fillStyle = ink; ctx.textAlign = 'right';
  ctx.fillText(`${final >= 0 ? '+' : ''}${formatFinancial(final)}`, width - frame.pad.right - 8, frame.y(final) - 10);
  $('#pnl-insight').textContent = `${final >= 0 ? 'PROFIT' : 'LOSS'} ${formatFinancial(Math.abs(final))}`;
  chartModels['pnl-chart'] = {
    count: run.gamesPerAgent,
    describe: index => {
      const trials = (index + 1) * run.agentCount;
      const cost = trials * run.gameCost;
      const reward = successes[index] * run.winReward;
      return `<strong>THROUGH GAME ${index + 1}</strong><br>${trials.toLocaleString()} games played<br>Cost: ${formatFinancial(cost)} · Reward: ${formatFinancial(reward)}<br>Observed P&L: ${observed[index] >= 0 ? '+' : ''}${formatFinancial(observed[index])}<br>Expected P&L: ${expected[index] >= 0 ? '+' : ''}${formatFinancial(expected[index])}`;
    }
  };
}

function drawAgentProfit(run) {
  const chart = getChartContext('agent-profit-chart');
  const { ctx, height, green, ink, pad } = chart;
  const profits = run.agents.map(agent => agent.successes * run.winReward - run.gamesPerAgent * run.gameCost);
  const minimum = Math.min(...profits);
  const maximum = Math.max(...profits);
  const binCount = minimum === maximum ? 1 : Math.min(24, Math.max(8, Math.ceil(Math.sqrt(run.agentCount))));
  const width = minimum === maximum ? 1 : (maximum - minimum) / binCount;
  const bins = Array.from({ length: binCount }, (_, index) => ({
    low: minimum + index * width,
    high: index === binCount - 1 ? maximum : minimum + (index + 1) * width,
    count: 0
  }));
  profits.forEach(profit => {
    const index = minimum === maximum ? 0 : Math.min(binCount - 1, Math.floor((profit - minimum) / width));
    bins[index].count++;
  });
  const maxCount = Math.max(...bins.map(bin => bin.count), 1);
  const ticks = [0, Math.ceil(maxCount / 2), maxCount].map(value => ({ value, ratio: value / maxCount }));
  const frame = chartFrame(chart, ticks, value => value, [formatFinancial(minimum), formatFinancial(maximum)]);
  const slot = frame.plotWidth / bins.length;
  bins.forEach((bin, index) => {
    const barHeight = bin.count / maxCount * frame.plotHeight;
    const midpoint = (bin.low + bin.high) / 2;
    ctx.fillStyle = midpoint >= 0 ? green : '#a74d32';
    ctx.fillRect(pad.left + index * slot + .5, pad.top + frame.plotHeight - barHeight, Math.max(1, slot - 1), barHeight);
  });
  const sorted = [...profits].sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const profitable = profits.filter(value => value > 0).length;
  $('#agent-profit-insight').textContent = `${profitable}/${run.agentCount} PROFITABLE · MEDIAN ${formatFinancial(median)}`;
  chartModels['agent-profit-chart'] = {
    count: bins.length,
    describe: index => `<strong>PROFIT BAND ${index + 1}</strong><br>${formatFinancial(bins[index].low)} to ${formatFinancial(bins[index].high)} net value<br>${bins[index].count} agents · ${(bins[index].count / run.agentCount * 100).toFixed(2)}% of the field`
  };
}

function drawSensitivity(run) {
  const chart = getChartContext('sensitivity-chart');
  const { ctx, ink } = chart;
  const samples = Array.from({ length: 301 }, (_, index) => {
    const probability = index / 300;
    return { probability, net: run.totalGames * (probability * run.winReward - run.gameCost) };
  });
  const frame = signedFrame(chart, samples[0].net, samples.at(-1).net, ['0%', '100%']);
  const x = probability => frame.pad.left + probability * frame.plotWidth;
  ctx.strokeStyle = '#08713d';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  samples.forEach((sample, index) => index ? ctx.lineTo(x(sample.probability), frame.y(sample.net)) : ctx.moveTo(x(sample.probability), frame.y(sample.net)));
  ctx.stroke();
  const breakEven = run.winReward > 0 ? run.gameCost / run.winReward : run.gameCost === 0 ? 0 : Infinity;
  if (Number.isFinite(breakEven) && breakEven >= 0 && breakEven <= 1) {
    ctx.strokeStyle = ink;
    ctx.globalAlpha = .55;
    ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(x(breakEven), frame.pad.top); ctx.lineTo(x(breakEven), frame.pad.top + frame.plotHeight); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.font = '9px "DM Mono", monospace';
    ctx.fillStyle = ink; ctx.textAlign = 'left';
    ctx.fillText(`BREAK-EVEN ${(breakEven * 100).toFixed(3)}%`, x(breakEven) + 5, frame.pad.top + 9);
  }
  const targetNet = run.totalGames * (run.successRate * run.winReward - run.gameCost);
  const actualRate = run.totalSuccesses / run.totalGames;
  const actualNet = run.totalSuccesses * run.winReward - run.totalGames * run.gameCost;
  [[run.successRate, targetNet, '#14251d'], [actualRate, actualNet, '#16a05d']].forEach(([probability, net, color]) => {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x(probability), frame.y(net), 4.5, 0, Math.PI * 2); ctx.fill();
  });
  $('#sensitivity-insight').textContent = Number.isFinite(breakEven) ? `BREAK-EVEN ${(breakEven * 100).toFixed(3)}%` : 'NO FINITE BREAK-EVEN';
  chartModels['sensitivity-chart'] = {
    count: samples.length,
    describe: index => {
      const sample = samples[index];
      const roi = run.gameCost === 0 ? (sample.net > 0 ? Infinity : 0) : (sample.probability * run.winReward - run.gameCost) / run.gameCost * 100;
      return `<strong>${(sample.probability * 100).toFixed(2)}% SUCCESS RATE</strong><br>Expected net value: ${sample.net >= 0 ? '+' : ''}${formatFinancial(sample.net)}<br>Expected ROI: ${Number.isFinite(roi) ? `${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%` : '∞'}<br>${sample.probability >= breakEven ? 'Above' : 'Below'} break-even`;
    }
  };
}

function attemptBoundary(probability, confidence) {
  if (probability >= 1) return 1;
  if (probability <= 0) return Infinity;
  return Math.max(1, Math.ceil(Math.log(1 - confidence) / Math.log(1 - probability)));
}

function drawSweepLine(id, series, options = {}) {
  const chart = getChartContext(id, options.dark);
  const { ctx, width, pad, ink } = chart;
  const values = series.flatMap(item => item.values).filter(Number.isFinite);
  let minimum = options.minimum ?? Math.min(0, ...values);
  let maximum = options.maximum ?? Math.max(1, ...values);
  if (maximum <= minimum) maximum = minimum + 1;
  const ticks = [0, .5, 1].map(ratio => ({ value: minimum + (maximum - minimum) * ratio, ratio }));
  const xLabels = options.xLabels ?? ['1%', '99%'];
  const { plotWidth, plotHeight } = chartFrame(chart, ticks, options.formatter ?? (value => value.toFixed(1)), xLabels);
  const count = Math.max(1, series[0]?.values.length ?? 1);
  const x = index => pad.left + index / Math.max(1, count - 1) * plotWidth;
  const y = value => pad.top + plotHeight * (1 - (value - minimum) / (maximum - minimum));

  if (minimum < 0 && maximum > 0) {
    ctx.strokeStyle = options.dark ? '#65736a' : '#7e8a81';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, y(0)); ctx.lineTo(width - pad.right, y(0)); ctx.stroke();
  }

  series.forEach(item => {
    ctx.strokeStyle = item.color;
    ctx.lineWidth = item.width ?? 2;
    ctx.setLineDash(item.dash ?? []);
    ctx.globalAlpha = item.alpha ?? 1;
    ctx.beginPath();
    item.values.forEach((value, index) => {
      if (!Number.isFinite(value)) return;
      if (index === 0) ctx.moveTo(x(index), y(value)); else ctx.lineTo(x(index), y(value));
    });
    ctx.stroke();
  });
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  const markerIndex = Math.max(0, Math.min(count - 1, options.markerIndex ?? sweepState.selectedProbability - 1));
  ctx.strokeStyle = options.markerColor ?? (options.dark ? '#fbfbf7' : ink);
  ctx.globalAlpha = .42;
  ctx.setLineDash([3, 4]);
  ctx.beginPath(); ctx.moveTo(x(markerIndex), pad.top); ctx.lineTo(x(markerIndex), pad.top + plotHeight); ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  return { chart, x, y, minimum, maximum, plotWidth, plotHeight };
}

function showSweep(sweep) {
  currentSweep = sweep;
  currentRun = null;
  pinnedChart = null;
  chartTooltip.classList.remove('visible');
  agentCountInput.value = sweep.agentCount;
  gameCountInput.value = sweep.gamesPerAgent;
  gameCostInput.value = sweep.gameCost;
  winRewardInput.value = sweep.winReward;
  resultsSection.classList.add('hidden');
  sweepResultsSection.classList.remove('hidden');
  $('#sweep-total').textContent = sweep.totalGames.toLocaleString();
  $('#sweep-duration').textContent = `${sweep.durationMs} ms`;
  const breakEven = sweep.winReward > 0 ? sweep.gameCost / sweep.winReward * 100 : sweep.gameCost === 0 ? 0 : Infinity;
  $('#sweep-breakeven').textContent = Number.isFinite(breakEven) ? `${breakEven.toFixed(3)}%` : 'NO FINITE RATE';
  updateSweepDecision();
}

function updateSweepDecision() {
  if (!currentSweep) return;
  const probabilityPercent = sweepState.selectedProbability;
  const probability = probabilityPercent / 100;
  const boundary = attemptBoundary(probability, sweepState.confidence);
  const withinLimit = boundary <= currentSweep.gamesPerAgent;
  const chanceAtLimit = (1 - Math.pow(1 - probability, currentSweep.gamesPerAgent)) * 100;
  const confidenceReached = (1 - Math.pow(1 - probability, Math.min(boundary, currentSweep.gamesPerAgent))) * 100;
  const maximumSpend = boundary * currentSweep.gameCost;
  const marginalValue = probability * currentSweep.winReward - currentSweep.gameCost;
  const slider = $('#sweep-probability');
  slider.value = probabilityPercent;
  slider.style.setProperty('--progress', `${probabilityPercent}%`);
  $('#selected-probability').textContent = `${probabilityPercent}%`;
  $('#decision-attempt').textContent = withinLimit ? `${boundary} ATTEMPT${boundary === 1 ? '' : 'S'}` : `>${currentSweep.gamesPerAgent} ATTEMPTS`;
  $('#decision-confidence-copy').textContent = withinLimit
    ? `${confidenceReached.toFixed(2)}% CHANCE OF ≥1 WIN`
    : `TARGET NEEDS ${boundary}; CURRENT LIMIT REACHES ${chanceAtLimit.toFixed(2)}%`;
  $('#decision-spend').textContent = formatFinancial(maximumSpend);
  const marginalOutput = $('#decision-marginal');
  marginalOutput.textContent = `${marginalValue >= 0 ? '+' : ''}${formatFinancial(marginalValue)}`;
  marginalOutput.className = marginalValue >= 0 ? 'positive' : 'negative';
  const valueSentence = marginalValue >= 0
    ? `Each additional independent try has positive expected value of ${formatFinancial(marginalValue)}.`
    : `Each additional independent try has negative expected value of ${formatFinancial(marginalValue)}.`;
  $('#decision-summary').textContent = `${probabilityPercent}% remains ${probabilityPercent}% after every miss. ${withinLimit ? `Attempt ${boundary} reaches your ${(sweepState.confidence * 100).toFixed(0)}% confidence target.` : `The current ${currentSweep.gamesPerAgent}-attempt limit cannot reach your ${(sweepState.confidence * 100).toFixed(0)}% target.`} ${valueSentence}`;
  document.querySelectorAll('[data-confidence]').forEach(button => {
    const active = Number(button.dataset.confidence) === sweepState.confidence;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  drawSweepAtlas(currentSweep);
}

function drawSweepAtlas(sweep) {
  const points = sweep.points;
  const selectedIndex = sweepState.selectedProbability - 1;
  const selected = points[selectedIndex];
  const fieldGames = sweep.agentCount * sweep.gamesPerAgent;
  const targets = points.map(point => point.probabilityPercent);
  const actualRates = points.map(point => point.actualRate * 100);
  const calibrationErrors = actualRates.map((value, index) => Math.abs(value - targets[index]));
  drawSweepLine('sweep-calibration-chart', [
    { values: targets, color: '#7f8a82', dash: [5, 5], width: 1.2 },
    { values: actualRates, color: '#16a05d', width: 2.3 }
  ], { minimum: 0, maximum: 100, formatter: value => `${value.toFixed(0)}%` });
  $('#sweep-calibration-insight').textContent = `MEAN ERROR ${(calibrationErrors.reduce((a, b) => a + b, 0) / 99).toFixed(3)} PTS`;
  chartModels['sweep-calibration-chart'] = {
    count: 99,
    describe: index => `<strong>${points[index].probabilityPercent}% TARGET ODDS</strong><br>${actualRates[index].toFixed(3)}% observed rate<br>${points[index].totalSuccesses.toLocaleString()} wins / ${fieldGames.toLocaleString()} games<br>${calibrationErrors[index].toFixed(3)} point calibration gap`
  };

  const outcomeChart = getChartContext('sweep-outcomes-chart', true);
  const outcomeFrame = chartFrame(outcomeChart, [0, .5, 1].map(ratio => ({ value: ratio * 100, ratio })), value => `${value.toFixed(0)}%`, ['1%', '99%']);
  const outcomeSlot = outcomeFrame.plotWidth / 99;
  points.forEach((point, index) => {
    const successHeight = point.actualRate * outcomeFrame.plotHeight;
    outcomeChart.ctx.fillStyle = index === selectedIndex ? '#fbfbf7' : '#d6f25c';
    outcomeChart.ctx.globalAlpha = index === selectedIndex ? 1 : .78;
    outcomeChart.ctx.fillRect(outcomeChart.pad.left + index * outcomeSlot, outcomeChart.pad.top + outcomeFrame.plotHeight - successHeight, Math.max(1, outcomeSlot), successHeight);
    outcomeChart.ctx.fillStyle = '#435249';
    outcomeChart.ctx.fillRect(outcomeChart.pad.left + index * outcomeSlot, outcomeChart.pad.top, Math.max(1, outcomeSlot), outcomeFrame.plotHeight - successHeight);
  });
  outcomeChart.ctx.globalAlpha = 1;
  $('#sweep-outcomes-insight').textContent = `${selected.probabilityPercent}% → ${selected.totalSuccesses.toLocaleString()} W / ${selected.totalFailures.toLocaleString()} L`;
  chartModels['sweep-outcomes-chart'] = {
    count: 99,
    describe: index => `<strong>${points[index].probabilityPercent}% PROBABILITY</strong><br>${points[index].totalSuccesses.toLocaleString()} wins · ${points[index].totalFailures.toLocaleString()} losses<br>${(points[index].actualRate * 100).toFixed(3)}% / ${(100 - points[index].actualRate * 100).toFixed(3)}% split`
  };

  const expectedNet = points.map(point => fieldGames * (point.probability * sweep.winReward - sweep.gameCost));
  const observedNet = points.map(point => point.observedNet);
  drawSweepLine('sweep-profit-chart', [
    { values: expectedNet, color: '#7f8a82', dash: [5, 5], width: 1.2 },
    { values: observedNet, color: '#16a05d', width: 2.2 }
  ], { formatter: value => formatFinancial(value, 1) });
  const breakEven = sweep.winReward > 0 ? sweep.gameCost / sweep.winReward * 100 : Infinity;
  $('#sweep-profit-insight').textContent = Number.isFinite(breakEven) ? `BREAK-EVEN ${breakEven.toFixed(3)}%` : 'NO FINITE BREAK-EVEN';
  chartModels['sweep-profit-chart'] = {
    count: 99,
    describe: index => `<strong>${points[index].probabilityPercent}% PROBABILITY</strong><br>Observed net: ${observedNet[index] >= 0 ? '+' : ''}${formatFinancial(observedNet[index])}<br>Expected net: ${expectedNet[index] >= 0 ? '+' : ''}${formatFinancial(expectedNet[index])}<br>${points[index].probabilityPercent >= breakEven ? 'Above' : 'Below'} break-even`
  };

  const observedCoverage = points.map(point => point.agentsWithSuccess / sweep.agentCount * 100);
  const expectedCoverage = points.map(point => (1 - Math.pow(1 - point.probability, sweep.gamesPerAgent)) * 100);
  drawSweepLine('sweep-coverage-chart', [
    { values: expectedCoverage, color: '#7f8a82', dash: [5, 5], width: 1.2 },
    { values: observedCoverage, color: '#16a05d', width: 2.2 }
  ], { minimum: 0, maximum: 100, formatter: value => `${value.toFixed(0)}%` });
  $('#sweep-coverage-insight').textContent = `${selected.probabilityPercent}% → ${observedCoverage[selectedIndex].toFixed(2)}% COVERED`;
  chartModels['sweep-coverage-chart'] = {
    count: 99,
    describe: index => `<strong>${points[index].probabilityPercent}% PROBABILITY</strong><br>${points[index].agentsWithSuccess.toLocaleString()} / ${sweep.agentCount.toLocaleString()} agents won at least once<br>${observedCoverage[index].toFixed(2)}% observed · ${expectedCoverage[index].toFixed(2)}% expected`
  };

  const boundaries = points.map(point => attemptBoundary(point.probability, sweepState.confidence));
  const maxBoundary = Math.max(sweep.gamesPerAgent, ...boundaries);
  drawSweepLine('sweep-stop-chart', [{ values: boundaries, color: '#14251d', width: 2.3 }], {
    minimum: 0, maximum: maxBoundary, formatter: value => `${Math.round(value)}×`, markerColor: '#14251d'
  });
  $('#sweep-stop-insight').textContent = `${(sweepState.confidence * 100).toFixed(0)}% TARGET · ${selected.probabilityPercent}% NEEDS ${boundaries[selectedIndex]}`;
  chartModels['sweep-stop-chart'] = {
    count: 99,
    describe: index => `<strong>${points[index].probabilityPercent}% PROBABILITY</strong><br>${boundaries[index]} attempts for ≥${(sweepState.confidence * 100).toFixed(0)}% chance of one win<br>${boundaries[index] <= sweep.gamesPerAgent ? 'Inside' : 'Beyond'} the ${sweep.gamesPerAgent}-game limit<br>${points[index].probabilityPercent}% chance remains on every next try`
  };

  const confidenceCosts = boundaries.map(boundary => boundary * sweep.gameCost);
  drawSweepLine('sweep-cost-chart', [{ values: confidenceCosts, color: '#16a05d', width: 2.3 }], {
    minimum: 0, formatter: value => formatFinancial(value, 1)
  });
  $('#sweep-cost-insight').textContent = `${selected.probabilityPercent}% → ${formatFinancial(confidenceCosts[selectedIndex])} MAX SPEND`;
  chartModels['sweep-cost-chart'] = {
    count: 99,
    describe: index => `<strong>${points[index].probabilityPercent}% PROBABILITY</strong><br>${formatFinancial(confidenceCosts[index])} maximum spend to the confidence boundary<br>${boundaries[index]} attempts × ${formatFinancial(sweep.gameCost)} per attempt`
  };

  const waitMedian = points.map(point => point.medianFirstSuccess);
  const waitP90 = points.map(point => point.p90FirstSuccess);
  drawSweepLine('sweep-wait-chart', [
    { values: waitP90, color: '#65736a', dash: [5, 5], width: 1.4 },
    { values: waitMedian, color: '#d6f25c', width: 2.3 }
  ], { dark: true, minimum: 0, maximum: sweep.gamesPerAgent + 1, formatter: value => `${Math.round(value)}G` });
  $('#sweep-wait-insight').textContent = `${selected.probabilityPercent}% → P50 ${waitMedian[selectedIndex]} / P90 ${waitP90[selectedIndex]}`;
  chartModels['sweep-wait-chart'] = {
    count: 99,
    describe: index => `<strong>${points[index].probabilityPercent}% PROBABILITY</strong><br>Median first win: ${waitMedian[index] > sweep.gamesPerAgent ? 'beyond limit' : `game ${waitMedian[index]}`}<br>90th percentile: ${waitP90[index] > sweep.gamesPerAgent ? 'beyond limit' : `game ${waitP90[index]}`}<br>Average among winners: ${points[index].averageFirstSuccess.toFixed(2)} games`
  };

  const observedZero = points.map(point => point.agentsWithoutSuccess / sweep.agentCount * 100);
  const expectedZero = points.map(point => Math.pow(1 - point.probability, sweep.gamesPerAgent) * 100);
  drawSweepLine('sweep-zero-chart', [
    { values: expectedZero, color: '#7f8a82', dash: [5, 5], width: 1.2 },
    { values: observedZero, color: '#a74d32', width: 2.2 }
  ], { minimum: 0, maximum: Math.max(1, expectedZero[0], observedZero[0]), formatter: value => `${value.toFixed(1)}%` });
  $('#sweep-zero-insight').textContent = `${selected.probabilityPercent}% → ${observedZero[selectedIndex].toFixed(2)}% NEVER WON`;
  chartModels['sweep-zero-chart'] = {
    count: 99,
    describe: index => `<strong>${points[index].probabilityPercent}% PROBABILITY</strong><br>${points[index].agentsWithoutSuccess} agents never won<br>${observedZero[index].toFixed(3)}% observed zero-win risk<br>${expectedZero[index].toFixed(3)}% theoretical risk`
  };

  const observedVolatility = points.map(point => point.successStdDev);
  const expectedVolatility = points.map(point => Math.sqrt(sweep.gamesPerAgent * point.probability * (1 - point.probability)));
  drawSweepLine('sweep-volatility-chart', [
    { values: expectedVolatility, color: '#7f8a82', dash: [5, 5], width: 1.2 },
    { values: observedVolatility, color: '#16a05d', width: 2.2 }
  ], { minimum: 0, formatter: value => value.toFixed(1) });
  $('#sweep-volatility-insight').textContent = `PEAK SPREAD ${Math.max(...observedVolatility).toFixed(2)} WINS`;
  chartModels['sweep-volatility-chart'] = {
    count: 99,
    describe: index => `<strong>${points[index].probabilityPercent}% PROBABILITY</strong><br>${observedVolatility[index].toFixed(3)} observed win-count deviation<br>${expectedVolatility[index].toFixed(3)} theoretical deviation<br>${points[index].averageSuccessesPerAgent.toFixed(2)} average wins per agent`
  };

  drawSweepDecisionCurve(sweep, selected);
}

function drawSweepDecisionCurve(sweep, point) {
  const probability = point.probability;
  const observedCoverage = [];
  let cumulativeAgents = 0;
  point.firstSuccessCounts.forEach(count => {
    cumulativeAgents += count;
    observedCoverage.push(cumulativeAgents / sweep.agentCount * 100);
  });
  const expectedCoverage = Array.from({ length: sweep.gamesPerAgent }, (_, index) => (1 - Math.pow(1 - probability, index + 1)) * 100);
  const missRisk = expectedCoverage.map(value => 100 - value);
  const boundary = attemptBoundary(probability, sweepState.confidence);
  const markerIndex = Math.min(sweep.gamesPerAgent - 1, boundary - 1);
  drawSweepLine('sweep-decision-chart', [
    { values: missRisk, color: '#a74d32', dash: [5, 5], width: 1.3 },
    { values: expectedCoverage, color: '#7f8a82', dash: [3, 4], width: 1.3 },
    { values: observedCoverage, color: '#16a05d', width: 2.4 }
  ], {
    minimum: 0,
    maximum: 100,
    formatter: value => `${value.toFixed(0)}%`,
    xLabels: ['ATTEMPT 1', `ATTEMPT ${sweep.gamesPerAgent}`],
    markerIndex
  });
  $('#sweep-decision-insight').textContent = boundary <= sweep.gamesPerAgent
    ? `${point.probabilityPercent}% · MOVE-ON BOUNDARY ${boundary}`
    : `${point.probabilityPercent}% · TARGET BEYOND ${sweep.gamesPerAgent}`;
  chartModels['sweep-decision-chart'] = {
    count: sweep.gamesPerAgent,
    describe: index => {
      const attempt = index + 1;
      return `<strong>ATTEMPT ${attempt} · ${point.probabilityPercent}% ODDS</strong><br>${observedCoverage[index].toFixed(2)}% observed agents have won<br>${expectedCoverage[index].toFixed(2)}% expected chance of ≥1 win<br>${missRisk[index].toFixed(2)}% chance still waiting<br>${formatFinancial(attempt * sweep.gameCost)} maximum spend`;
    }
  };
}

function chartIndexAt(canvas, event, count) {
  const rect = canvas.getBoundingClientRect();
  const plotLeft = 43;
  const plotRight = rect.width - 13;
  const x = event.clientX - rect.left;
  if (x < plotLeft || x > plotRight) return -1;
  const ratio = Math.min(.999999, Math.max(0, (x - plotLeft) / Math.max(1, plotRight - plotLeft)));
  return Math.min(count - 1, Math.floor(ratio * count));
}

function showChartTooltip(canvas, event, index, pinned = false) {
  const model = chartModels[canvas.id];
  if (!model || index < 0) return;
  chartTooltip.innerHTML = `${model.describe(index)}<br><small>${pinned ? 'PINNED · CLICK AGAIN TO RELEASE' : 'CLICK TO PIN THIS VALUE'}</small>`;
  chartTooltip.classList.add('visible');
  const left = Math.min(window.innerWidth - 285, event.clientX + 16);
  const top = Math.min(window.innerHeight - 135, event.clientY + 16);
  chartTooltip.style.left = `${Math.max(8, left)}px`;
  chartTooltip.style.top = `${Math.max(8, top)}px`;
}

document.querySelectorAll('.data-chart:not(#first-success-chart)').forEach(canvas => {
  canvas.addEventListener('pointermove', event => {
    const model = chartModels[canvas.id];
    if (!model) return;
    const index = chartIndexAt(canvas, event, model.count);
    if (index >= 0) showChartTooltip(canvas, event, index, pinnedChart?.id === canvas.id && pinnedChart.index === index);
    else if (!pinnedChart) chartTooltip.classList.remove('visible');
  });
  canvas.addEventListener('click', event => {
    const model = chartModels[canvas.id];
    if (!model) return;
    const index = chartIndexAt(canvas, event, model.count);
    if (index < 0) return;
    if (currentSweep && canvas.classList.contains('sweep-selectable')) {
      sweepState.selectedProbability = index + 1;
      updateSweepDecision();
    }
    const samePoint = pinnedChart?.id === canvas.id && pinnedChart.index === index;
    pinnedChart = samePoint ? null : { id: canvas.id, index };
    if (samePoint) chartTooltip.classList.remove('visible');
    else showChartTooltip(canvas, event, index, true);
  });
  canvas.addEventListener('pointerleave', () => {
    if (!pinnedChart || pinnedChart.id !== canvas.id) chartTooltip.classList.remove('visible');
  });
});

$('#sweep-probability').addEventListener('input', event => {
  sweepState.selectedProbability = Number(event.target.value);
  pinnedChart = null;
  chartTooltip.classList.remove('visible');
  updateSweepDecision();
});

document.querySelectorAll('[data-confidence]').forEach(button => button.addEventListener('click', () => {
  sweepState.confidence = Number(button.dataset.confidence);
  pinnedChart = null;
  chartTooltip.classList.remove('visible');
  updateSweepDecision();
}));

function waitingIndexAt(event) {
  if (!waitingData) return -1;
  const canvas = $('#first-success-chart');
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const plotRight = rect.width - WAIT_PAD.right;
  if (x < WAIT_PAD.left || x > plotRight) return -1;
  const ratio = Math.min(.999999, Math.max(0, (x - WAIT_PAD.left) / Math.max(1, plotRight - WAIT_PAD.left)));
  const visibleCount = waitingData.viewEnd - waitingData.viewStart + 1;
  return waitingData.viewStart + Math.min(visibleCount - 1, Math.floor(ratio * visibleCount));
}

function showWaitingTooltip(event, index) {
  if (!waitingData || index < 0) return;
  const { run, counts, expected, cumulative, survival } = waitingData;
  const heading = index === run.gamesPerAgent ? 'NO SUCCESS' : `FIRST SUCCESS · GAME ${index + 1}`;
  const detail = index === run.gamesPerAgent
    ? `Completed all ${run.gamesPerAgent.toLocaleString()} games without succeeding`
    : `${index} prior failure${index === 1 ? '' : 's'} before the first success`;
  chartTooltip.innerHTML = `<strong>${heading}</strong><br>${counts[index]} observed agents · ${expected[index].toFixed(2)} expected<br>${(counts[index] / run.agentCount * 100).toFixed(2)}% of agents<br>${cumulative[index].toFixed(2)}% cumulative success · ${survival[index].toFixed(2)}% still waiting<br>${detail}<br><small>PRESS AND DRAG TO SELECT A RANGE</small>`;
  chartTooltip.classList.add('visible');
  const left = Math.min(window.innerWidth - 300, event.clientX + 16);
  const top = Math.min(window.innerHeight - 155, event.clientY + 16);
  chartTooltip.style.left = `${Math.max(8, left)}px`;
  chartTooltip.style.top = `${Math.max(8, top)}px`;
}

const waitingCanvas = $('#first-success-chart');
waitingCanvas.addEventListener('pointerdown', event => {
  const index = waitingIndexAt(event);
  if (index < 0 || !currentRun) return;
  event.preventDefault();
  waitingState.dragging = true;
  waitingState.dragOrigin = index;
  waitingState.selection = [index, index];
  waitingState.hoverIndex = index;
  waitingCanvas.setPointerCapture(event.pointerId);
  chartTooltip.classList.remove('visible');
  drawFirstSuccess(currentRun);
});

waitingCanvas.addEventListener('pointermove', event => {
  if (!currentRun || !waitingData) return;
  const index = waitingIndexAt(event);
  if (index < 0) return;
  waitingState.hoverIndex = index;
  if (waitingState.dragging) {
    waitingState.selection = [Math.min(waitingState.dragOrigin, index), Math.max(waitingState.dragOrigin, index)];
    chartTooltip.classList.remove('visible');
  } else {
    showWaitingTooltip(event, index);
  }
  drawFirstSuccess(currentRun);
});

waitingCanvas.addEventListener('pointerup', event => {
  if (!waitingState.dragging || !currentRun) return;
  waitingState.dragging = false;
  if (waitingCanvas.hasPointerCapture(event.pointerId)) waitingCanvas.releasePointerCapture(event.pointerId);
  drawFirstSuccess(currentRun);
});

waitingCanvas.addEventListener('pointerleave', () => {
  if (waitingState.dragging || !currentRun) return;
  waitingState.hoverIndex = null;
  chartTooltip.classList.remove('visible');
  drawFirstSuccess(currentRun);
});

document.querySelectorAll('[data-wait-metric]').forEach(button => button.addEventListener('click', () => {
  waitingState.metric = button.dataset.waitMetric;
  if (currentRun) drawFirstSuccess(currentRun);
}));

document.querySelectorAll('[data-wait-scale]').forEach(button => button.addEventListener('click', () => {
  waitingState.scale = button.dataset.waitScale;
  if (currentRun) drawFirstSuccess(currentRun);
}));

document.querySelectorAll('[data-wait-layer]').forEach(button => button.addEventListener('click', () => {
  const layer = button.dataset.waitLayer;
  waitingState.layers[layer] = !waitingState.layers[layer];
  if (currentRun) drawFirstSuccess(currentRun);
}));

$('#waiting-zoom').addEventListener('click', () => {
  if (!currentRun || !waitingState.selection) return;
  waitingState.view = [...waitingState.selection];
  waitingState.hoverIndex = null;
  drawFirstSuccess(currentRun);
});

$('#waiting-reset').addEventListener('click', () => {
  if (!currentRun) return;
  waitingState.view = [0, currentRun.gamesPerAgent];
  waitingState.selection = null;
  waitingState.hoverIndex = null;
  chartTooltip.classList.remove('visible');
  drawFirstSuccess(currentRun);
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    pinnedChart = null;
    chartTooltip.classList.remove('visible');
    if (currentRun && waitingState.selection) {
      waitingState.selection = null;
      waitingState.hoverIndex = null;
      drawFirstSuccess(currentRun);
    }
  }
});

let chartResizeTimer;
window.addEventListener('resize', () => {
  if (!currentRun && !currentSweep) return;
  clearTimeout(chartResizeTimer);
  chartResizeTimer = setTimeout(() => {
    if (currentRun) drawAnalytics(currentRun);
    if (currentSweep) drawSweepAtlas(currentSweep);
  }, 120);
});
$('#export-button').addEventListener('click', () => {
  if (!currentRun) return;
  const header = ['agent', 'successes', 'net_profit', ...Array.from({ length: currentRun.gamesPerAgent }, (_, i) => `game_${i + 1}`)];
  const rows = currentRun.agents.map(agent => [agent.id, agent.successes, agent.successes * currentRun.winReward - currentRun.gamesPerAgent * currentRun.gameCost, ...agent.outcomes].join(','));
  const blob = new Blob([[header.join(','), ...rows].join('\n')], { type: 'text/csv' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `probability-run-${currentRun.id}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
});
