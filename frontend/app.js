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
const sweepState = { selectedIndex: 0 };
const targetPlannerState = { mode: 'profit', profit: 10, roiPercent: 100 };
const SWEEP_PROBABILITY_COUNT = 1089;
const SWEEP_CONFIDENCE = .9;
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

function integerValue(input) {
  if (input.value.trim() === '') return NaN;
  return Number(input.value);
}

function financialValue(input) {
  if (input.value.trim() === '') return NaN;
  return Number(input.value);
}

function updateWorkload() {
  if (experimentMode === 'uncertain') return updateUncertainWorkload();
  const agents = integerValue(agentCountInput);
  const games = integerValue(gameCountInput);
  const gameCost = financialValue(gameCostInput);
  const winReward = financialValue(winRewardInput);
  const multiplier = experimentMode === 'sweep' ? SWEEP_PROBABILITY_COUNT : 1;
  const total = agents * games * multiplier;
  totalGamesOutput.textContent = Number.isFinite(total) ? total.toLocaleString() : '—';
  $('#total-games-label').textContent = experimentMode === 'sweep' ? 'TOTAL GAMES · 1,089 FIELDS' : 'TOTAL GAMES';
  runButton.querySelector('.button-label').textContent = experimentMode === 'sweep' ? 'RUN 0.01—99.9% SWEEP' : 'RUN EXPERIMENT';
  const invalidEconomics = !Number.isFinite(gameCost) || gameCost < 0 || !Number.isFinite(winReward) || winReward < 0;
  const invalid = !Number.isInteger(agents) || agents < 1 || !Number.isInteger(games) || games < 1 || invalidEconomics;
  workloadWarning.classList.toggle('invalid', invalid);
  workloadWarning.textContent = invalidEconomics
    ? 'COST AND REWARD MUST BE FINITE, NON-NEGATIVE NUMBERS'
    : invalid
      ? 'AGENTS AND GAMES MUST BE POSITIVE WHOLE NUMBERS'
      : experimentMode === 'sweep'
        ? '1,089 PROBABILITIES · NO PROJECT LIMIT · MACHINE-BOUND'
        : 'NO PROJECT LIMIT · CAPACITY DEPENDS ON THIS MACHINE';
  runButton.disabled = invalid;
  return { agents, games, gameCost, winReward, total, invalid };
}

agentCountInput.addEventListener('input', updateWorkload);
gameCountInput.addEventListener('input', updateWorkload);
gameCostInput.addEventListener('input', updateWorkload);
winRewardInput.addEventListener('input', updateWorkload);
updateWorkload();

function setExperimentMode(mode) {
  experimentMode = ['fixed', 'sweep', 'uncertain'].includes(mode) ? mode : 'fixed';
  document.querySelectorAll('[data-mode]').forEach(button => {
    const active = button.dataset.mode === experimentMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  fixedRatePanel.classList.toggle('hidden', experimentMode !== 'fixed');
  sweepRatePanel.classList.toggle('hidden', experimentMode !== 'sweep');
  uncertainRatePanel.classList.toggle('hidden', experimentMode !== 'uncertain');
  beliefDeck.classList.toggle('hidden', experimentMode !== 'uncertain');
  uncertainSpec.classList.toggle('hidden', experimentMode !== 'uncertain');
  runSpec.classList.toggle('hidden', experimentMode === 'uncertain');
  updateWorkload();
}

document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => setExperimentMode(button.dataset.mode)));

runButton.addEventListener('click', async () => {
  const workload = updateWorkload();
  if (workload.invalid) return;
  runButton.disabled = true;
  runButton.classList.add('loading');
  try {
    const endpoint = experimentMode === 'uncertain' ? '/api/uncertain'
      : experimentMode === 'sweep' ? '/api/sweeps' : '/api/runs';
    const requestBody = experimentMode === 'uncertain' ? uncertainRequest(workload) : {
      ...(experimentMode === 'fixed' ? { successRate: clampRate(rateNumber.value) / 100 } : {}),
      agentCount: workload.agents,
      gamesPerAgent: workload.games,
      gameCost: workload.gameCost,
      winReward: workload.winReward
    };
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Experiment failed');
    const payload = await response.json();
    if (experimentMode === 'uncertain') {
      showUncertain(payload);
      uncertainResultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (experimentMode === 'sweep') {
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
  uncertainResultsSection.classList.add('hidden');
  currentUncertain = null;
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
  if (absolute >= 1000000000000000) return value.toExponential(2).replace('e+', 'e');
  if (absolute >= 1000000000000) return `${(value / 1000000000000).toFixed(2)}T`;
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

function formatProbability(probabilityPercent) {
  return probabilityPercent < 1
    ? `${probabilityPercent.toFixed(2)}%`
    : `${Number.isInteger(probabilityPercent) ? probabilityPercent.toFixed(0) : probabilityPercent.toFixed(1)}%`;
}

function drawSweepLine(id, series, options = {}) {
  const chart = getChartContext(id, options.dark);
  const { ctx, width, pad, ink } = chart;
  const values = series.flatMap(item => item.values).filter(Number.isFinite);
  let minimum = options.minimum ?? Math.min(0, ...values);
  let maximum = options.maximum ?? Math.max(1, ...values);
  if (maximum <= minimum) maximum = minimum + 1;
  const ticks = [0, .5, 1].map(ratio => ({ value: minimum + (maximum - minimum) * ratio, ratio }));
  const xLabels = options.xLabels ?? ['0.01%', '99.9%'];
  const { plotWidth, plotHeight } = chartFrame(chart, ticks, options.formatter ?? (value => value.toFixed(1)), xLabels);
  const count = Math.max(1, series[0]?.values.length ?? 1);
  const xValues = options.xValues ?? Array.from({ length: count }, (_, index) => index);
  const minimumX = xValues[0] ?? 0;
  const maximumX = xValues[xValues.length - 1] ?? Math.max(1, count - 1);
  const x = index => pad.left + (xValues[index] - minimumX) / Math.max(Number.EPSILON, maximumX - minimumX) * plotWidth;
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

  const markerIndex = Math.max(0, Math.min(count - 1, options.markerIndex ?? sweepState.selectedIndex));
  ctx.strokeStyle = options.markerColor ?? (options.dark ? '#fbfbf7' : ink);
  ctx.globalAlpha = .42;
  ctx.setLineDash([3, 4]);
  ctx.beginPath(); ctx.moveTo(x(markerIndex), pad.top); ctx.lineTo(x(markerIndex), pad.top + plotHeight); ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  return { chart, x, y, minimum, maximum, plotWidth, plotHeight };
}

function targetPlannerResult(sweep) {
  const cost = sweep.gameCost;
  const reward = sweep.winReward;
  const roi = targetPlannerState.roiPercent / 100;
  const desiredProfit = targetPlannerState.profit;
  let attempts;

  if (cost === 0) {
    const feasible = targetPlannerState.mode === 'profit' ? desiredProfit <= reward : reward > 0;
    attempts = feasible ? Infinity : 0;
  } else if (targetPlannerState.mode === 'profit') {
    attempts = Math.max(0, Math.floor((reward - desiredProfit) / cost + 1e-12));
  } else {
    attempts = Math.max(0, Math.floor(reward / (cost * (1 + roi)) + 1e-12));
  }

  const cumulativeCost = Number.isFinite(attempts) ? attempts * cost : 0;
  const profitAtDeadline = attempts > 0 ? reward - cumulativeCost : null;
  const concreteRoiTarget = targetPlannerState.mode === 'roi' && attempts > 0
    ? cumulativeCost * roi
    : desiredProfit;
  return { attempts, cumulativeCost, profitAtDeadline, concreteRoiTarget };
}

function chanceWithin(probability, attempts) {
  if (attempts === Infinity) return probability > 0 ? 1 : 0;
  if (attempts <= 0 || probability <= 0) return 0;
  if (probability >= 1) return 1;
  return -Math.expm1(attempts * Math.log1p(-probability));
}

function syncTargetPlannerControls(sweep) {
  const profitMode = targetPlannerState.mode === 'profit';
  const range = $('#target-range');
  const exact = $('#target-number');
  const maximumProfit = Math.max(0, sweep.winReward);
  const sliderMaximum = maximumProfit > 0 ? maximumProfit : 1;
  const value = profitMode
    ? Math.max(0, targetPlannerState.profit)
    : Math.max(1, Math.min(500, targetPlannerState.roiPercent));
  const rangeValue = profitMode ? Math.min(sliderMaximum, value) : value;

  if (profitMode) targetPlannerState.profit = value;
  else targetPlannerState.roiPercent = value;
  range.min = profitMode ? 0 : 1;
  range.max = profitMode ? sliderMaximum : 500;
  range.step = profitMode ? Math.max(sliderMaximum / 500, Number.EPSILON) : 1;
  range.value = rangeValue;
  exact.min = profitMode ? 0 : 1;
  if (profitMode) exact.removeAttribute('max');
  else exact.max = 500;
  exact.step = profitMode ? 'any' : 1;
  exact.value = value;
  const progress = (rangeValue - Number(range.min)) / Math.max(Number.EPSILON, Number(range.max) - Number(range.min)) * 100;
  range.style.setProperty('--progress', `${progress}%`);
  $('#target-label').textContent = profitMode ? 'NET PROFIT TARGET' : 'REALIZED ROI TARGET';
  $('#target-display').textContent = profitMode ? formatFinancial(value) : `${value.toFixed(0)}%`;
  $('#target-min').textContent = profitMode ? formatFinancial(0) : '1%';
  $('#target-max').textContent = profitMode ? formatFinancial(maximumProfit) : '500%';
  $('#target-unit').textContent = profitMode ? 'NET' : '% ROI';
  range.setAttribute('aria-label', profitMode ? 'Concrete net profit target' : 'ROI target percentage');
  document.querySelectorAll('[data-target-mode]').forEach(button => {
    const active = button.dataset.targetMode === targetPlannerState.mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function drawTargetPlannerGraph(sweep) {
  syncTargetPlannerControls(sweep);
  const points = sweep.points;
  const targets = points.map(point => point.probabilityPercent);
  const selectedIndex = sweepState.selectedIndex;
  const selected = points[selectedIndex];
  const result = targetPlannerResult(sweep);
  const observedAttempts = result.attempts === Infinity
    ? sweep.gamesPerAgent
    : Math.min(result.attempts, sweep.gamesPerAgent);
  const expectedCoverage = points.map(point => chanceWithin(point.probability, result.attempts) * 100);
  const observedCoverage = points.map(point => {
    if (observedAttempts <= 0) return 0;
    const winsInTime = point.firstSuccessCounts
      .slice(0, observedAttempts)
      .reduce((sum, count) => sum + count, 0);
    return winsInTime / sweep.agentCount * 100;
  });
  const ninetyLine = points.map(() => 90);
  drawSweepLine('sweep-calibration-chart', [
    { values: ninetyLine, color: '#a74d32', dash: [4, 5], width: 1.1, alpha: .65 },
    { values: observedCoverage, color: '#7f8a82', dash: [5, 5], width: 1.4 },
    { values: expectedCoverage, color: '#16a05d', width: 2.5 }
  ], { minimum: 0, maximum: 100, formatter: value => `${value.toFixed(0)}%`, xValues: targets });

  const attemptsText = result.attempts === Infinity
    ? 'NO COST LIMIT'
    : result.attempts === 0
      ? 'DO NOT PLAY'
      : `${result.attempts.toLocaleString()} ATTEMPT${result.attempts === 1 ? '' : 'S'}`;
  const selectedChance = expectedCoverage[selectedIndex];
  const targetText = targetPlannerState.mode === 'profit'
    ? `${formatFinancial(targetPlannerState.profit)} NET`
    : `${targetPlannerState.roiPercent.toFixed(0)}% ROI`;
  $('#target-attempts').textContent = attemptsText;
  $('#target-rule').textContent = targetPlannerState.mode === 'profit'
    ? 'REWARD − CUMULATIVE COST ≥ TARGET'
    : `ROI TARGET = ${formatFinancial(result.concreteRoiTarget)} AT THIS DEADLINE`;
  $('#target-cost').textContent = result.attempts === Infinity ? formatFinancial(0) : formatFinancial(result.cumulativeCost);
  $('#target-profit').textContent = result.profitAtDeadline === null ? 'IMPOSSIBLE' : formatFinancial(result.profitAtDeadline);
  $('#target-chance-label').textContent = `CHANCE AT ${formatProbability(selected.probabilityPercent)}`;
  $('#target-chance').textContent = `${selectedChance.toFixed(2)}%`;
  $('#sweep-calibration-insight').textContent = `${targetText} · ${attemptsText} · ${formatProbability(selected.probabilityPercent)} → ${selectedChance.toFixed(2)}%`;

  chartModels['sweep-calibration-chart'] = {
    count: points.length,
    xValues: targets,
    describe: index => {
      const observedNote = result.attempts > sweep.gamesPerAgent || result.attempts === Infinity
        ? `Observed uses the available ${sweep.gamesPerAgent.toLocaleString()}-game simulation window`
        : `Observed through attempt ${observedAttempts.toLocaleString()}`;
      return `<strong>${formatProbability(points[index].probabilityPercent)} ODDS · ${attemptsText}</strong><br>${expectedCoverage[index].toFixed(3)}% theoretical chance of ≥1 win before stopping<br>${observedCoverage[index].toFixed(3)}% observed agent coverage<br>${observedNote}<br>Required return: ${targetText}`;
    }
  };
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
  uncertainResultsSection.classList.add('hidden');
  currentUncertain = null;
  $('#sweep-total').textContent = sweep.totalGames.toLocaleString();
  $('#sweep-probability-count').textContent = sweep.probabilityCount.toLocaleString();
  $('#sweep-duration').textContent = `${sweep.durationMs} ms`;
  const breakEven = sweep.breakEvenProbabilityPercent;
  $('#sweep-breakeven').textContent = Number.isFinite(breakEven) ? formatProbability(breakEven) : 'NO FINITE RATE';
  const winningIndex = sweep.points.findIndex(point => point.probabilityPercent === sweep.firstWinningProbabilityPercent);
  sweepState.selectedIndex = winningIndex >= 0 ? winningIndex : sweep.points.length - 1;
  targetPlannerState.profit = Math.max(0, sweep.winReward * .1);
  updateSweepDecision();
}

function updateSweepDecision() {
  if (!currentSweep) return;
  const points = currentSweep.points;
  sweepState.selectedIndex = Math.max(0, Math.min(points.length - 1, sweepState.selectedIndex));
  const inspected = points[sweepState.selectedIndex];
  const winningProbabilityPercent = currentSweep.firstWinningProbabilityPercent;
  const boundary = currentSweep.recommendedAttempts90;
  const winningPoint = points.find(point => point.probabilityPercent === winningProbabilityPercent);
  const hasWinningOdds = winningPoint && Number.isFinite(boundary);
  const slider = $('#sweep-probability');
  slider.max = Math.max(0, points.length - 1);
  slider.value = sweepState.selectedIndex;
  slider.style.setProperty('--progress', `${sweepState.selectedIndex / Math.max(1, points.length - 1) * 100}%`);
  $('#selected-probability').textContent = formatProbability(inspected.probabilityPercent);
  $('#jump-winning').disabled = !hasWinningOdds;

  if (!hasWinningOdds) {
    $('#decision-attempt').textContent = 'DO NOT PLAY';
    $('#decision-confidence-copy').textContent = 'NO TESTED ODDS HAVE POSITIVE EXPECTED VALUE';
    $('#decision-winning-probability').textContent = 'NONE ≤99.9%';
    $('#decision-spend').textContent = formatFinancial(0);
    const marginalOutput = $('#decision-marginal');
    const bestValue = .999 * currentSweep.winReward - currentSweep.gameCost;
    marginalOutput.textContent = `${bestValue >= 0 ? '+' : ''}${formatFinancial(bestValue)}`;
    marginalOutput.className = bestValue >= 0 ? 'positive' : 'negative';
    $('#decision-summary').textContent = `Even at 99.9%, reward × probability − cost is not positive. Under this rule, the rational move-on boundary is zero attempts: choose a different game.`;
    drawSweepAtlas(currentSweep);
    return;
  }

  const probability = winningPoint.probability;
  const withinLimit = boundary <= currentSweep.gamesPerAgent;
  const confidenceReached = (1 - Math.pow(1 - probability, boundary)) * 100;
  const chanceAtLimit = (1 - Math.pow(1 - probability, currentSweep.gamesPerAgent)) * 100;
  const maximumSpend = boundary * currentSweep.gameCost;
  const marginalValue = probability * currentSweep.winReward - currentSweep.gameCost;
  $('#decision-attempt').textContent = `${boundary} ATTEMPT${boundary === 1 ? '' : 'S'}`;
  $('#decision-confidence-copy').textContent = withinLimit
    ? `${confidenceReached.toFixed(2)}% CHANCE OF ≥1 WIN`
    : `REQUIRES ${boundary}; ${currentSweep.gamesPerAgent} ATTEMPTS REACH ${chanceAtLimit.toFixed(2)}%`;
  $('#decision-winning-probability').textContent = formatProbability(winningProbabilityPercent);
  $('#decision-spend').textContent = formatFinancial(maximumSpend);
  const marginalOutput = $('#decision-marginal');
  marginalOutput.textContent = `${marginalValue >= 0 ? '+' : ''}${formatFinancial(marginalValue)}`;
  marginalOutput.className = marginalValue >= 0 ? 'positive' : 'negative';
  $('#decision-summary').textContent = `Expected value first becomes positive at ${formatProbability(winningProbabilityPercent)}. At those odds, ${boundary} attempts give a ${confidenceReached.toFixed(2)}% chance of at least one win. If all ${boundary} miss, move on—each independent next try still remains ${formatProbability(winningProbabilityPercent)}.`;
  drawSweepAtlas(currentSweep);
}

function drawSweepAtlas(sweep) {
  const points = sweep.points;
  const selectedIndex = sweepState.selectedIndex;
  const selected = points[selectedIndex];
  const fieldGames = sweep.agentCount * sweep.gamesPerAgent;
  const targets = points.map(point => point.probabilityPercent);
  drawTargetPlannerGraph(sweep);

  const outcomeChart = getChartContext('sweep-outcomes-chart', true);
  const outcomeFrame = chartFrame(outcomeChart, [0, .5, 1].map(ratio => ({ value: ratio * 100, ratio })), value => `${value.toFixed(0)}%`, ['0.01%', '99.9%']);
  const outcomeX = value => outcomeChart.pad.left + (value - targets[0]) / (targets[targets.length - 1] - targets[0]) * outcomeFrame.plotWidth;
  const outcomeWidth = Math.max(.55, outcomeFrame.plotWidth / 1000 * .72);
  points.forEach((point, index) => {
    const successHeight = point.actualRate * outcomeFrame.plotHeight;
    outcomeChart.ctx.fillStyle = index === selectedIndex ? '#fbfbf7' : '#d6f25c';
    outcomeChart.ctx.globalAlpha = index === selectedIndex ? 1 : .78;
    outcomeChart.ctx.fillRect(outcomeX(point.probabilityPercent) - outcomeWidth / 2, outcomeChart.pad.top + outcomeFrame.plotHeight - successHeight, outcomeWidth, successHeight);
    outcomeChart.ctx.fillStyle = '#435249';
    outcomeChart.ctx.fillRect(outcomeX(point.probabilityPercent) - outcomeWidth / 2, outcomeChart.pad.top, outcomeWidth, outcomeFrame.plotHeight - successHeight);
  });
  outcomeChart.ctx.globalAlpha = 1;
  $('#sweep-outcomes-insight').textContent = `${formatProbability(selected.probabilityPercent)} → ${selected.totalSuccesses.toLocaleString()} W / ${selected.totalFailures.toLocaleString()} L`;
  chartModels['sweep-outcomes-chart'] = {
    count: points.length,
    xValues: targets,
    describe: index => `<strong>${formatProbability(points[index].probabilityPercent)} PROBABILITY</strong><br>${points[index].totalSuccesses.toLocaleString()} wins · ${points[index].totalFailures.toLocaleString()} losses<br>${(points[index].actualRate * 100).toFixed(3)}% / ${(100 - points[index].actualRate * 100).toFixed(3)}% split`
  };

  const expectedNet = points.map(point => fieldGames * (point.probability * sweep.winReward - sweep.gameCost));
  const observedNet = points.map(point => point.observedNet);
  drawSweepLine('sweep-profit-chart', [
    { values: expectedNet, color: '#7f8a82', dash: [5, 5], width: 1.2 },
    { values: observedNet, color: '#16a05d', width: 2.2 }
  ], { formatter: value => formatFinancial(value, 1), xValues: targets });
  const breakEven = sweep.breakEvenProbabilityPercent;
  $('#sweep-profit-insight').textContent = Number.isFinite(breakEven) ? `BREAK-EVEN ${breakEven.toFixed(3)}%` : 'NO FINITE BREAK-EVEN';
  chartModels['sweep-profit-chart'] = {
    count: points.length,
    xValues: targets,
    describe: index => `<strong>${formatProbability(points[index].probabilityPercent)} PROBABILITY</strong><br>Observed net: ${observedNet[index] >= 0 ? '+' : ''}${formatFinancial(observedNet[index])}<br>Expected net: ${expectedNet[index] >= 0 ? '+' : ''}${formatFinancial(expectedNet[index])}<br>${points[index].probabilityPercent > breakEven ? 'Above' : 'At or below'} break-even`
  };

  const observedCoverage = points.map(point => point.agentsWithSuccess / sweep.agentCount * 100);
  const expectedCoverage = points.map(point => (1 - Math.pow(1 - point.probability, sweep.gamesPerAgent)) * 100);
  drawSweepLine('sweep-coverage-chart', [
    { values: expectedCoverage, color: '#7f8a82', dash: [5, 5], width: 1.2 },
    { values: observedCoverage, color: '#16a05d', width: 2.2 }
  ], { minimum: 0, maximum: 100, formatter: value => `${value.toFixed(0)}%`, xValues: targets });
  $('#sweep-coverage-insight').textContent = `${formatProbability(selected.probabilityPercent)} → ${observedCoverage[selectedIndex].toFixed(2)}% COVERED`;
  chartModels['sweep-coverage-chart'] = {
    count: points.length,
    xValues: targets,
    describe: index => `<strong>${formatProbability(points[index].probabilityPercent)} PROBABILITY</strong><br>${points[index].agentsWithSuccess.toLocaleString()} / ${sweep.agentCount.toLocaleString()} agents won at least once<br>${observedCoverage[index].toFixed(2)}% observed · ${expectedCoverage[index].toFixed(2)}% expected`
  };

  const boundaries = points.map(point => attemptBoundary(point.probability, SWEEP_CONFIDENCE));
  const maxBoundary = Math.max(sweep.gamesPerAgent, ...boundaries);
  drawSweepLine('sweep-stop-chart', [{ values: boundaries, color: '#14251d', width: 2.3 }], {
    minimum: 0, maximum: maxBoundary, formatter: value => `${Math.round(value)}×`, markerColor: '#14251d', xValues: targets
  });
  $('#sweep-stop-insight').textContent = `90% TARGET · ${formatProbability(selected.probabilityPercent)} NEEDS ${boundaries[selectedIndex]}`;
  chartModels['sweep-stop-chart'] = {
    count: points.length,
    xValues: targets,
    describe: index => `<strong>${formatProbability(points[index].probabilityPercent)} PROBABILITY</strong><br>${boundaries[index]} attempts for ≥90% chance of one win<br>${boundaries[index] <= sweep.gamesPerAgent ? 'Inside' : 'Beyond'} the ${sweep.gamesPerAgent}-game limit<br>${formatProbability(points[index].probabilityPercent)} chance remains on every next try`
  };

  const confidenceCosts = boundaries.map(boundary => boundary * sweep.gameCost);
  drawSweepLine('sweep-cost-chart', [{ values: confidenceCosts, color: '#16a05d', width: 2.3 }], {
    minimum: 0, formatter: value => formatFinancial(value, 1), xValues: targets
  });
  $('#sweep-cost-insight').textContent = `${formatProbability(selected.probabilityPercent)} → ${formatFinancial(confidenceCosts[selectedIndex])} MAX SPEND`;
  chartModels['sweep-cost-chart'] = {
    count: points.length,
    xValues: targets,
    describe: index => `<strong>${formatProbability(points[index].probabilityPercent)} PROBABILITY</strong><br>${formatFinancial(confidenceCosts[index])} maximum spend to the 90% boundary<br>${boundaries[index]} attempts × ${formatFinancial(sweep.gameCost)} per attempt`
  };

  const waitMedian = points.map(point => point.medianFirstSuccess);
  const waitP90 = points.map(point => point.p90FirstSuccess);
  drawSweepLine('sweep-wait-chart', [
    { values: waitP90, color: '#65736a', dash: [5, 5], width: 1.4 },
    { values: waitMedian, color: '#d6f25c', width: 2.3 }
  ], { dark: true, minimum: 0, maximum: sweep.gamesPerAgent + 1, formatter: value => `${Math.round(value)}G`, xValues: targets });
  $('#sweep-wait-insight').textContent = `${formatProbability(selected.probabilityPercent)} → P50 ${waitMedian[selectedIndex]} / P90 ${waitP90[selectedIndex]}`;
  chartModels['sweep-wait-chart'] = {
    count: points.length,
    xValues: targets,
    describe: index => `<strong>${formatProbability(points[index].probabilityPercent)} PROBABILITY</strong><br>Median first win: ${waitMedian[index] > sweep.gamesPerAgent ? 'beyond limit' : `game ${waitMedian[index]}`}<br>90th percentile: ${waitP90[index] > sweep.gamesPerAgent ? 'beyond limit' : `game ${waitP90[index]}`}<br>Average among winners: ${points[index].averageFirstSuccess.toFixed(2)} games`
  };

  const observedZero = points.map(point => point.agentsWithoutSuccess / sweep.agentCount * 100);
  const expectedZero = points.map(point => Math.pow(1 - point.probability, sweep.gamesPerAgent) * 100);
  drawSweepLine('sweep-zero-chart', [
    { values: expectedZero, color: '#7f8a82', dash: [5, 5], width: 1.2 },
    { values: observedZero, color: '#a74d32', width: 2.2 }
  ], { minimum: 0, maximum: Math.max(1, expectedZero[0], observedZero[0]), formatter: value => `${value.toFixed(1)}%`, xValues: targets });
  $('#sweep-zero-insight').textContent = `${formatProbability(selected.probabilityPercent)} → ${observedZero[selectedIndex].toFixed(2)}% NEVER WON`;
  chartModels['sweep-zero-chart'] = {
    count: points.length,
    xValues: targets,
    describe: index => `<strong>${formatProbability(points[index].probabilityPercent)} PROBABILITY</strong><br>${points[index].agentsWithoutSuccess} agents never won<br>${observedZero[index].toFixed(3)}% observed zero-win risk<br>${expectedZero[index].toFixed(3)}% theoretical risk`
  };

  const observedVolatility = points.map(point => point.successStdDev);
  const expectedVolatility = points.map(point => Math.sqrt(sweep.gamesPerAgent * point.probability * (1 - point.probability)));
  drawSweepLine('sweep-volatility-chart', [
    { values: expectedVolatility, color: '#7f8a82', dash: [5, 5], width: 1.2 },
    { values: observedVolatility, color: '#16a05d', width: 2.2 }
  ], { minimum: 0, formatter: value => value.toFixed(1), xValues: targets });
  $('#sweep-volatility-insight').textContent = `PEAK SPREAD ${Math.max(...observedVolatility).toFixed(2)} WINS`;
  chartModels['sweep-volatility-chart'] = {
    count: points.length,
    xValues: targets,
    describe: index => `<strong>${formatProbability(points[index].probabilityPercent)} PROBABILITY</strong><br>${observedVolatility[index].toFixed(3)} observed win-count deviation<br>${expectedVolatility[index].toFixed(3)} theoretical deviation<br>${points[index].averageSuccessesPerAgent.toFixed(2)} average wins per agent`
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
  const boundary = attemptBoundary(probability, SWEEP_CONFIDENCE);
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
    ? `${formatProbability(point.probabilityPercent)} · 90% BOUNDARY ${boundary}`
    : `${formatProbability(point.probabilityPercent)} · 90% TARGET BEYOND ${sweep.gamesPerAgent}`;
  chartModels['sweep-decision-chart'] = {
    count: sweep.gamesPerAgent,
    describe: index => {
      const attempt = index + 1;
      return `<strong>ATTEMPT ${attempt} · ${formatProbability(point.probabilityPercent)} ODDS</strong><br>${observedCoverage[index].toFixed(2)}% observed agents have won<br>${expectedCoverage[index].toFixed(2)}% expected chance of ≥1 win<br>${missRisk[index].toFixed(2)}% chance still waiting<br>${formatFinancial(attempt * sweep.gameCost)} maximum spend`;
    }
  };
}

function chartIndexAt(canvas, event, model) {
  const rect = canvas.getBoundingClientRect();
  // Charts that draw their own axes report the padding they used, so the
  // hover position keeps matching the plot after a layout change.
  const plotLeft = model.pad?.left ?? 43;
  const plotRight = rect.width - (model.pad?.right ?? 13);
  const x = event.clientX - rect.left;
  if (x < plotLeft || x > plotRight) return -1;
  const ratio = Math.min(.999999, Math.max(0, (x - plotLeft) / Math.max(1, plotRight - plotLeft)));
  if (model.xValues?.length) {
    const values = model.xValues;
    const target = values[0] + ratio * (values[values.length - 1] - values[0]);
    let closest = 0;
    for (let index = 1; index < values.length; index++) {
      if (Math.abs(values[index] - target) < Math.abs(values[closest] - target)) closest = index;
    }
    return closest;
  }
  return Math.min(model.count - 1, Math.floor(ratio * model.count));
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
    const index = chartIndexAt(canvas, event, model);
    if (index >= 0) showChartTooltip(canvas, event, index, pinnedChart?.id === canvas.id && pinnedChart.index === index);
    else if (!pinnedChart) chartTooltip.classList.remove('visible');
  });
  canvas.addEventListener('click', event => {
    const model = chartModels[canvas.id];
    if (!model) return;
    const index = chartIndexAt(canvas, event, model);
    if (index < 0) return;
    if (currentSweep && canvas.classList.contains('sweep-selectable')) {
      sweepState.selectedIndex = index;
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
  sweepState.selectedIndex = Number(event.target.value);
  pinnedChart = null;
  chartTooltip.classList.remove('visible');
  updateSweepDecision();
});

$('#jump-winning').addEventListener('click', () => {
  if (!currentSweep) return;
  const winningIndex = currentSweep.points.findIndex(point => point.probabilityPercent === currentSweep.firstWinningProbabilityPercent);
  if (winningIndex < 0) return;
  sweepState.selectedIndex = winningIndex;
  pinnedChart = null;
  chartTooltip.classList.remove('visible');
  updateSweepDecision();
});

function updateTargetPlanner() {
  if (!currentSweep) return;
  pinnedChart = null;
  chartTooltip.classList.remove('visible');
  drawTargetPlannerGraph(currentSweep);
}

document.querySelectorAll('[data-target-mode]').forEach(button => button.addEventListener('click', () => {
  targetPlannerState.mode = button.dataset.targetMode === 'roi' ? 'roi' : 'profit';
  updateTargetPlanner();
}));

$('#target-range').addEventListener('input', event => {
  const value = Number(event.target.value);
  if (!Number.isFinite(value)) return;
  if (targetPlannerState.mode === 'profit') targetPlannerState.profit = Math.max(0, value);
  else targetPlannerState.roiPercent = Math.max(1, Math.min(500, value));
  updateTargetPlanner();
});

$('#target-number').addEventListener('input', event => {
  if (event.target.value.trim() === '') return;
  const value = Number(event.target.value);
  if (!Number.isFinite(value)) return;
  if (targetPlannerState.mode === 'profit') targetPlannerState.profit = Math.max(0, value);
  else targetPlannerState.roiPercent = Math.max(1, Math.min(500, value));
  updateTargetPlanner();
});

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
  if (!currentRun && !currentSweep && !currentUncertain) return;
  clearTimeout(chartResizeTimer);
  chartResizeTimer = setTimeout(() => {
    if (currentRun) drawAnalytics(currentRun);
    if (currentSweep) drawSweepAtlas(currentSweep);
    if (currentUncertain) drawUncertain(currentUncertain);
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

/* ================================================================= UNCERTAIN WORLD
 * The third mode. Every parameter is stated as three numbers — a best guess, how
 * wrong it could be, and how wrong that could be — and the engine returns exact
 * results for each drawn world rather than a simulation of them.
 */

const uncertainResultsSection = $('#uncertain-results');
const beliefDeck = $('#uncertain-parameters');
const uncertainRatePanel = $('#uncertain-rate-panel');
const uncertainSpec = $('#uncertain-spec');
const runSpec = document.querySelector('.run-spec:not(#uncertain-spec)');
let currentUncertain = null;
let learningLaw = 'logit';

/**
 * Uncertainty is entered as a percentage of the best guess, which is what a
 * coefficient of variation is. Probabilities and the improvement rate are
 * entered in the units people actually think in and converted on the way out.
 */
const BELIEFS = [
  {
    key: 'entryCost', label: 'Entry cost', unit: '',
    hint: 'Paid once before the first attempt. Leave at zero if there is no cost to start.',
    mean: 0, uncertainty: 20, meta: 30, step: 'any', min: 0
  },
  {
    key: 'attemptCost', label: 'Cost per attempt', unit: '',
    hint: 'Charged every single time you try, win or lose.',
    mean: 1, uncertainty: 20, meta: 30, step: 'any', min: 0
  },
  {
    key: 'winReward', label: 'Reward per win', unit: '',
    hint: 'What one win pays. The run stops at the first win.',
    mean: 100, uncertainty: 30, meta: 30, step: 'any', min: 0
  },
  {
    key: 'baseProbability', label: 'Starting win chance', unit: '%',
    hint: 'Your chance of winning on the very first attempt, before any learning.',
    mean: 2, uncertainty: 50, meta: 40, step: 'any', min: 0.0001, max: 99.9999, percent: true
  },
  {
    key: 'learningRate', label: 'Improvement per attempt', unit: '%',
    hint: 'Under the log-odds law, how much your odds grow each attempt. Under the ceiling law, how much of the remaining gap you close. Zero means you never improve.',
    mean: 1, uncertainty: 60, meta: 50, step: 'any', min: 0, max: 99.9, rate: true
  },
  {
    key: 'skillCeiling', label: 'Skill ceiling', unit: '%',
    hint: 'The best you could ever become. Only the ceiling law uses this.',
    mean: 60, uncertainty: 20, meta: 30, step: 'any', min: 0.0001, max: 99.9999, percent: true, ceilingOnly: true
  }
];

function buildBeliefRows() {
  $('#belief-rows').innerHTML = BELIEFS.map(belief => `
    <div class="belief-row" data-belief-row="${belief.key}">
      <div class="belief-name"><strong>${belief.label}</strong><small>${belief.hint}</small></div>
      <div class="belief-field" data-label="BEST GUESS">
        <input type="number" step="${belief.step}" value="${belief.mean}" data-belief="${belief.key}" data-field="mean"
               aria-label="${belief.label}, best guess">${belief.unit ? `<i>${belief.unit}</i>` : ''}
      </div>
      <div class="belief-field" data-label="UNCERTAINTY">
        <input type="number" step="any" min="0" max="1000" value="${belief.uncertainty}" data-belief="${belief.key}" data-field="uncertainty"
               aria-label="${belief.label}, uncertainty"><i>%</i>
      </div>
      <div class="belief-field" data-label="DOUBT ABOUT THE DOUBT">
        <input type="number" step="any" min="0" max="1000" value="${belief.meta}" data-belief="${belief.key}" data-field="meta"
               aria-label="${belief.label}, doubt about the doubt"><i>%</i>
      </div>
    </div>`).join('');
  $('#belief-rows').querySelectorAll('input').forEach(input => {
    input.addEventListener('input', updateWorkload);
  });
  applyLearningLaw();
}

function applyLearningLaw() {
  document.querySelectorAll('[data-law]').forEach(button => {
    const active = button.dataset.law === learningLaw;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  // The skill ceiling has no meaning under the log-odds law, so it is dimmed
  // rather than hidden: the number stays where the reader last saw it.
  BELIEFS.filter(belief => belief.ceilingOnly).forEach(belief => {
    const row = document.querySelector(`[data-belief-row="${belief.key}"]`);
    if (row) row.classList.toggle('disabled', learningLaw !== 'ceiling');
  });
}

document.querySelectorAll('[data-law]').forEach(button => button.addEventListener('click', () => {
  learningLaw = button.dataset.law;
  applyLearningLaw();
}));

function beliefInput(key, field) {
  return document.querySelector(`input[data-belief="${key}"][data-field="${field}"]`);
}

/** Reads the belief table, flags anything unusable, and returns the request payload. */
function readBeliefs() {
  const payload = {};
  let invalid = false;
  BELIEFS.forEach(belief => {
    const raw = {
      mean: Number(beliefInput(belief.key, 'mean').value),
      uncertainty: Number(beliefInput(belief.key, 'uncertainty').value),
      meta: Number(beliefInput(belief.key, 'meta').value)
    };
    const badMean = !Number.isFinite(raw.mean) || raw.mean < (belief.min ?? 0)
      || (belief.max !== undefined && raw.mean > belief.max);
    const badUncertainty = !Number.isFinite(raw.uncertainty) || raw.uncertainty < 0 || raw.uncertainty > 1000;
    const badMeta = !Number.isFinite(raw.meta) || raw.meta < 0 || raw.meta > 1000;
    beliefInput(belief.key, 'mean').classList.toggle('invalid', badMean);
    beliefInput(belief.key, 'uncertainty').classList.toggle('invalid', badUncertainty);
    beliefInput(belief.key, 'meta').classList.toggle('invalid', badMeta);
    if (badMean || badUncertainty || badMeta) {
      invalid = true;
      return;
    }
    let mean = raw.mean;
    if (belief.percent) mean = raw.mean / 100;
    if (belief.rate) mean = improvementToRate(raw.mean / 100);
    payload[belief.key] = {
      mean,
      uncertainty: raw.uncertainty / 100,
      metaUncertainty: raw.meta / 100
    };
  });
  return { payload, invalid };
}

/**
 * Turns a per-attempt improvement percentage into the rate the engine wants.
 * Under the log-odds law the odds grow by that fraction each attempt; under the
 * ceiling law that fraction of the remaining gap is closed.
 */
function improvementToRate(fraction) {
  if (!(fraction > 0)) return 0;
  return learningLaw === 'ceiling'
    ? -Math.log(Math.max(1e-9, 1 - Math.min(0.999, fraction)))
    : Math.log1p(fraction);
}

function rateToImprovement(rate) {
  if (!(rate > 0)) return 0;
  return learningLaw === 'ceiling' ? 1 - Math.exp(-rate) : Math.expm1(rate);
}

function updateUncertainWorkload() {
  const attempts = Number($('#uncertain-attempts').value);
  const beliefs = readBeliefs();
  const badHorizon = !Number.isInteger(attempts) || attempts < 1 || attempts > 5000000;

  const warning = $('#uncertain-warning');
  warning.classList.toggle('invalid', badHorizon || beliefs.invalid);
  warning.textContent = beliefs.invalid
    ? 'A HIGHLIGHTED BELIEF IS OUT OF RANGE'
    : badHorizon
      ? 'THE ATTEMPT LIMIT MUST BE A POSITIVE WHOLE NUMBER'
      : 'THE ENGINE MEASURES ITS OWN ERROR AND KEEPS WORKING UNTIL THE ANSWER IS STEADY';

  runButton.querySelector('.button-label').textContent = 'EXPLORE EVERY WORLD';
  const invalid = badHorizon || beliefs.invalid;
  runButton.disabled = invalid;
  return { invalid, attempts, beliefs: beliefs.payload };
}

$('#uncertain-attempts').addEventListener('input', updateWorkload);

// Sampling effort is a choice about patience, not about the game. AUTO lets the
// engine size its own run; the other settings pin the number of worlds so a run
// is either quick or as precise as you are willing to wait for.
let samplingEffort = 'auto';
document.querySelectorAll('[data-effort]').forEach(button => button.addEventListener('click', () => {
  samplingEffort = button.dataset.effort;
  document.querySelectorAll('[data-effort]').forEach(other => {
    const active = other === button;
    other.classList.toggle('active', active);
    other.setAttribute('aria-pressed', String(active));
  });
}));

// How many worlds to explore is a question about the sampler, not about the game,
// so it is not asked. The engine sizes its own run from a pilot and reports the
// precision it actually reached.
function uncertainRequest(workload) {
  const request = { ...workload.beliefs, maxAttempts: workload.attempts, learningLaw };
  if (samplingEffort !== 'auto') request.worlds = Number(samplingEffort);
  return request;
}

/* --------------------------------------------------------------- presentation */

function showUncertain(result) {
  currentUncertain = result;
  currentRun = null;
  currentSweep = null;
  pinnedChart = null;
  chartTooltip.classList.remove('visible');
  resultsSection.classList.add('hidden');
  sweepResultsSection.classList.add('hidden');
  uncertainResultsSection.classList.remove('hidden');

  const optimal = result.optimal;
  $('#uncertain-universe-count').textContent = Number(result.universeCount).toLocaleString();
  $('#uncertain-horizon').textContent = Number(result.maxAttempts).toLocaleString();
  $('#uncertain-law').textContent = result.learningLaw === 'ceiling' ? 'CEILING' : 'LOG-ODDS';
  $('#uncertain-duration').textContent = `${result.durationMs} ms`;
  const precision = result.precision;
  $('#uncertain-precision').textContent = Number.isFinite(precision.standardError)
    ? `± ${formatFinancial(precision.standardError)}`
    : '—';
  $('#uncertain-total').textContent = Number(precision.worlds).toLocaleString();

  $('#uncertain-stop').textContent = Number(optimal.attempts).toLocaleString();
  $('#uncertain-stop-note').textContent = optimal.attempts >= result.maxAttempts
    ? 'THE HORIZON IS STILL THE BEST PLACE TO STOP — TRY EXTENDING IT'
    : `ATTEMPTS · BEYOND THIS THE AVERAGE ATTEMPT COSTS MORE THAN IT RETURNS`;
  setSigned($('#uncertain-profit'), optimal.expectedProfit);
  if (Number.isFinite(precision.standardError) && precision.standardError > 0) {
    $('#uncertain-profit').textContent += ` ± ${formatFinancial(precision.standardError)}`;
  }
  $('#uncertain-spend').textContent = formatFinancial(optimal.expectedSpend);
  const roi = optimal.roiPercent;
  $('#uncertain-roi').textContent = Number.isFinite(roi) ? `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%` : '—';
  $('#uncertain-roi').className = Number.isFinite(roi) ? (roi >= 0 ? 'positive' : 'negative') : '';

  $('#uncertain-profit-chance').textContent = `${(optimal.profitChance * 100).toFixed(1)}%`;
  $('#uncertain-win-chance').textContent =
    `${(optimal.winChance * 100).toFixed(1)}% CHANCE OF AT LEAST ONE WIN BY THEN`;
  setSigned($('#uncertain-p50'), optimal.profitP50);
  setSigned($('#uncertain-p05'), optimal.profitP05);
  setSigned($('#uncertain-cvar'), optimal.conditionalValueAtRisk05);

  $('#uncertain-decision-summary').textContent = decisionSentence(result);
  drawUncertain(result);
}

function setSigned(element, value) {
  if (!Number.isFinite(value)) {
    element.textContent = '—';
    element.className = '';
    return;
  }
  element.textContent = `${value >= 0 ? '+' : ''}${formatFinancial(value)}`;
  element.className = value >= 0 ? 'positive' : 'negative';
}

/** A plain-language reading of the result, including when the answer is "do not play". */
function decisionSentence(result) {
  const optimal = result.optimal;
  const total = optimal.varianceTotal || 1;
  const luckShare = optimal.varianceLuck / total;
  const knowledgeShare = (optimal.varianceParameter + optimal.varianceHyper) / total;
  const worst = [...result.sensitivity].sort((a, b) => b.share - a.share)[0];
  const bestToLearn = [...result.valueOfInformation.parameters].sort((a, b) => b.value - a.value)[0];

  if (optimal.expectedProfit <= 0) {
    return `On these beliefs the game does not pay: even the best stopping rule loses ${formatFinancial(Math.abs(optimal.expectedProfit))} on average. `
      + `The least bad plan is ${optimal.attempts} attempt${optimal.attempts === 1 ? '' : 's'}. `
      + `${knowledgeShare > .5 ? 'Most of that is uncertainty rather than bad odds, so a better estimate could change the answer' : 'That verdict is driven by the odds themselves, not by what you do not know'}.`;
  }
  return `Stop after ${optimal.attempts} attempt${optimal.attempts === 1 ? '' : 's'} for an expected ${formatFinancial(optimal.expectedProfit)}, `
    + `though you only finish ahead ${(optimal.profitChance * 100).toFixed(0)}% of the time. `
    + `${(luckShare * 100).toFixed(0)}% of the risk is the luck of the game and ${(knowledgeShare * 100).toFixed(0)}% is not knowing your own numbers`
    + `${worst && worst.share > .25 ? `, mostly ${worst.label.toLowerCase()}` : ''}. `
    + `${bestToLearn && bestToLearn.value > 0 ? `Pinning down ${bestToLearn.label.toLowerCase()} is worth up to ${formatFinancial(bestToLearn.value)}.` : ''}`;
}

/* --------------------------------------------------------------------- charts
 * Every chart here carries labelled axes, a named marker for the recommended
 * stopping point, and its key numbers written onto the plot. The earlier
 * versions relied on the footer legend to explain what a line meant and left
 * the horizontal scale unlabelled, which made a logarithmic axis impossible to
 * read: without ticks there is no way to tell whether the middle of the plot is
 * attempt 20 or attempt 200.
 */

const UNCERTAIN_PAD = { left: 66, right: 18, top: 22, bottom: 48 };
const BAND_INNER = 'rgba(22,160,93,.30)';
const BAND_OUTER = 'rgba(22,160,93,.13)';
const BAND_INNER_DARK = 'rgba(214,242,92,.30)';
const BAND_OUTER_DARK = 'rgba(214,242,92,.12)';
const LOSS_COLOUR = '#a74d32';
const LUCK_COLOUR = '#8d9a90';

/** Round numbers for an axis, so ticks land on values a reader can hold in mind. */
function niceTicks(min, max, count = 4) {
  if (!(max > min)) return [min];
  const rough = (max - min) / count;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalised = rough / magnitude;
  const step = (normalised >= 5 ? 10 : normalised >= 2 ? 5 : normalised >= 1 ? 2 : 1) * magnitude;
  const ticks = [];
  for (let value = Math.ceil(min / step) * step; value <= max + step * 1e-9; value += step) {
    ticks.push(Math.abs(value) < step * 1e-9 ? 0 : value);
  }
  return ticks.length >= 2 ? ticks : [min, max];
}

/** 1, 2, 5, 10, 20, 50 … so a logarithmic axis reads like a ruler. */
function attemptTicks(maxAttempts) {
  const ticks = [1];
  for (let magnitude = 1; magnitude <= maxAttempts; magnitude *= 10) {
    for (const multiple of [2, 5, 10]) {
      const value = magnitude * multiple;
      if (value > 1 && value < maxAttempts) ticks.push(value);
    }
  }
  ticks.push(maxAttempts);
  return ticks;
}

function shortNumber(value) {
  const size = Math.abs(value);
  if (size < 1e-9) return '0';
  if (size >= 1_000_000) return `${trimZeros(value / 1_000_000, 1)}M`;
  if (size >= 1_000) return `${trimZeros(value / 1_000, 1)}k`;
  if (size >= 10) return value.toFixed(0);
  if (size >= 1) return trimZeros(value, 1);
  return trimZeros(value, 2);
}

/** 2.0 reads as clutter next to 2; drop a decimal that carries nothing. */
function trimZeros(value, digits) {
  return Number(value.toFixed(digits)).toString();
}

/**
 * A plot area with both axes drawn and titled.
 *
 * @param options.xLog     attempts on a logarithmic scale
 * @param options.xTitle   caption under the horizontal axis
 * @param options.yTitle   caption above the vertical axis
 * @param options.yFormat  how to render a vertical tick
 */
function plotFrame(id, options) {
  const chart = getChartContext(id, options.dark);
  const { ctx, width, height, ink, muted } = chart;
  const pad = UNCERTAIN_PAD;
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;

  let min = options.min;
  let max = options.max;
  if (!(max > min)) max = min + 1;
  const yTicks = options.yTicks ?? niceTicks(min, max, 4);
  if (yTicks.length) {
    min = Math.min(min, yTicks[0]);
    max = Math.max(max, yTicks[yTicks.length - 1]);
  }

  const y = value => pad.top + plotHeight * (1 - (value - min) / (max - min));
  const xMin = options.xLog ? Math.log(1) : options.xMin;
  const xMax = options.xLog ? Math.log(Math.max(2, options.xMax)) : options.xMax;
  const x = value => pad.left
    + ((options.xLog ? Math.log(Math.max(1, value)) : value) - xMin) / Math.max(1e-12, xMax - xMin) * plotWidth;

  ctx.font = '9px "DM Mono", monospace';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;

  // Horizontal gridlines and their values.
  yTicks.forEach(value => {
    const position = Math.round(y(value)) + .5;
    ctx.strokeStyle = muted;
    ctx.globalAlpha = value === 0 ? .55 : .28;
    ctx.beginPath();
    ctx.moveTo(pad.left, position);
    ctx.lineTo(width - pad.right, position);
    ctx.stroke();
    ctx.globalAlpha = .8;
    ctx.fillStyle = ink;
    ctx.textAlign = 'right';
    ctx.fillText((options.yFormat ?? shortNumber)(value), pad.left - 9, position);
  });

  // Vertical ticks along the bottom.
  const xTicks = options.xTicks ?? [];
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  xTicks.forEach(value => {
    const position = Math.round(x(value)) + .5;
    if (position < pad.left - 1 || position > width - pad.right + 1) return;
    ctx.strokeStyle = muted;
    ctx.globalAlpha = .22;
    ctx.beginPath();
    ctx.moveTo(position, pad.top);
    ctx.lineTo(position, pad.top + plotHeight);
    ctx.stroke();
    ctx.globalAlpha = .8;
    ctx.fillStyle = ink;
    ctx.fillText((options.xFormat ?? shortNumber)(value), position, pad.top + plotHeight + 7);
  });

  // Axis captions.
  ctx.globalAlpha = .62;
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  if (options.xTitle) ctx.fillText(options.xTitle, pad.left + plotWidth / 2, height - 13);
  if (options.yTitle) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(options.yTitle, pad.left - 57, pad.top - 8);
  }
  ctx.globalAlpha = 1;
  ctx.textBaseline = 'middle';

  return { ...chart, pad, x, y, min, max, plotWidth, plotHeight };
}

function clampToFrame(frame, value) {
  if (!Number.isFinite(value)) return frame.min;
  return Math.min(frame.max, Math.max(frame.min, value));
}

function drawBand(frame, positions, lower, upper, colour) {
  const { ctx, x, y } = frame;
  ctx.fillStyle = colour;
  ctx.beginPath();
  positions.forEach((position, index) => {
    const point = y(clampToFrame(frame, upper[index]));
    if (index === 0) ctx.moveTo(x(position), point); else ctx.lineTo(x(position), point);
  });
  for (let index = positions.length - 1; index >= 0; index--) {
    ctx.lineTo(x(positions[index]), y(clampToFrame(frame, lower[index])));
  }
  ctx.closePath();
  ctx.fill();
}

function drawSeries(frame, positions, values, colour, width = 2, dash = []) {
  const { ctx, x, y } = frame;
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  let started = false;
  positions.forEach((position, index) => {
    const value = values[index];
    if (!Number.isFinite(value)) return;
    const point = y(clampToFrame(frame, value));
    if (!started) { ctx.moveTo(x(position), point); started = true; } else ctx.lineTo(x(position), point);
  });
  ctx.stroke();
  ctx.setLineDash([]);
}

/** A small filled caption, so a line can say what it is without a legend lookup. */
function chip(frame, text, atX, atY, colour, align = 'left') {
  const { ctx } = frame;
  ctx.font = '8px "DM Mono", monospace';
  ctx.textBaseline = 'middle';
  const width = ctx.measureText(text).width + 10;
  let left = align === 'left' ? atX + 4 : atX - width - 4;
  const limit = frame.width - frame.pad.right - width - 1;
  left = Math.max(frame.pad.left + 1, Math.min(left, limit));
  ctx.fillStyle = colour;
  ctx.globalAlpha = .92;
  ctx.fillRect(left, atY - 7, width, 14);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#fbfbf7';
  ctx.textAlign = 'left';
  ctx.fillText(text, left + 5, atY);
  ctx.font = '9px "DM Mono", monospace';
}

/** The vertical rule for the recommended stopping point, captioned in place. */
function drawStopMarker(frame, attempt, colour, label = `STOP ${attempt}`) {
  const { ctx, x, pad, plotHeight, width } = frame;
  const position = x(attempt);
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.globalAlpha = .8;
  ctx.beginPath();
  ctx.moveTo(position, pad.top);
  ctx.lineTo(position, pad.top + plotHeight);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  const nearRightEdge = position > width - pad.right - 70;
  chip(frame, label, position, pad.top + 8, colour, nearRightEdge ? 'right' : 'left');
}

function drawZeroLine(frame, colour) {
  if (!(frame.min < 0 && frame.max > 0)) return;
  const { ctx, y, pad, width } = frame;
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.2;
  ctx.globalAlpha = .85;
  ctx.beginPath();
  ctx.moveTo(pad.left, y(0));
  ctx.lineTo(width - pad.right, y(0));
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function extent(...series) {
  let min = Infinity;
  let max = -Infinity;
  series.forEach(values => values.forEach(value => {
    if (!Number.isFinite(value)) return;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }));
  if (!Number.isFinite(min)) return [0, 1];
  if (min === max) return [min - 1, max + 1];
  const padding = (max - min) * .1;
  return [min - padding, max + padding];
}

function attemptModel(result, attempts, describe) {
  return {
    count: attempts.length,
    xValues: attempts.map(attempt => Math.log(Math.max(1, attempt))),
    pad: UNCERTAIN_PAD,
    describe
  };
}

function nearestCoarse(result, attempt) {
  let best = 0;
  result.coarseAttempts.forEach((value, index) => {
    if (Math.abs(value - attempt) < Math.abs(result.coarseAttempts[best] - attempt)) best = index;
  });
  return best;
}

function drawUncertain(result) {
  drawUncertainProfit(result);
  drawUncertainMarginal(result);
  drawUncertainLearning(result);
  drawUncertainDistribution(result);
  drawUncertainChance(result);
  drawUncertainVariance(result);
  drawUncertainSensitivity(result);
  drawUncertainInformation(result);
  drawUncertainProgress(result);
}

/* 01 — profit against where you stop */
function drawUncertainProfit(result) {
  const [min, max] = extent(result.expectedProfit, result.profitP05, result.profitP95);
  const frame = plotFrame('uncertain-profit-chart', {
    min, max, xLog: true, xMax: result.maxAttempts, xTicks: attemptTicks(result.maxAttempts),
    xFormat: shortNumber, xTitle: 'ATTEMPTS BEFORE YOU STOP  (LOGARITHMIC)', yTitle: 'PROFIT'
  });
  drawBand(frame, result.coarseAttempts, result.profitP05, result.profitP95, BAND_OUTER);
  drawBand(frame, result.coarseAttempts, result.profitP25, result.profitP75, BAND_INNER);
  drawZeroLine(frame, '#5d6a61');
  drawSeries(frame, result.attempts, result.expectedProfit, frame.green, 2.4);
  drawStopMarker(frame, result.optimal.attempts, frame.ink);
  if (frame.min < 0 && frame.max > 0) chip(frame, 'BREAK EVEN', frame.pad.left, frame.y(0), '#5d6a61');

  $('#uncertain-profit-insight').textContent =
    `BEST AT ${result.optimal.attempts} · ${formatFinancial(result.optimal.expectedProfit)}`;
  chartModels['uncertain-profit-chart'] = attemptModel(result, result.attempts, index => {
    const attempt = result.attempts[index];
    const coarse = nearestCoarse(result, attempt);
    return `<strong>STOP AFTER ${attempt}</strong><br>`
      + `Expected: ${formatFinancial(result.expectedProfit[index])}<br>`
      + `Middle half: ${formatFinancial(result.profitP25[coarse])} to ${formatFinancial(result.profitP75[coarse])}<br>`
      + `Middle 90%: ${formatFinancial(result.profitP05[coarse])} to ${formatFinancial(result.profitP95[coarse])}<br>`
      + `Ends ahead: ${(result.profitChance[coarse] * 100).toFixed(1)}%`;
  });
}

/* 02 — is one more try worth it */
function drawUncertainMarginal(result) {
  const [min, max] = extent(result.marginalValue, [0]);
  const frame = plotFrame('uncertain-marginal-chart', {
    min, max, xLog: true, xMax: result.maxAttempts, xTicks: attemptTicks(result.maxAttempts),
    xTitle: 'ATTEMPT NUMBER  (LOGARITHMIC)', yTitle: 'VALUE OF THAT ONE ATTEMPT',
    yFormat: value => value.toFixed(Math.abs(max - min) < 1 ? 2 : 1)
  });
  drawZeroLine(frame, '#3d4a42');
  drawSeries(frame, result.attempts, result.marginalValue, '#14251d', 2.2);

  let crossing = null;
  for (let index = 1; index < result.attempts.length; index++) {
    if (result.marginalValue[index - 1] >= 0 && result.marginalValue[index] < 0) {
      crossing = result.attempts[index];
      break;
    }
  }
  if (crossing) {
    drawStopMarker(frame, crossing, LOSS_COLOUR, `WORTHLESS FROM ${crossing}`);
  } else {
    drawStopMarker(frame, result.optimal.attempts, '#14251d');
  }
  if (frame.min < 0 && frame.max > 0) {
    chip(frame, 'ABOVE THIS LINE = WORTH TRYING', frame.pad.left, frame.y(0), '#3d4a42');
  }

  $('#uncertain-marginal-insight').textContent = crossing
    ? `STOPS PAYING AT ATTEMPT ${crossing}`
    : 'STILL WORTH IT AT THE HORIZON';
  chartModels['uncertain-marginal-chart'] = attemptModel(result, result.attempts, index =>
    `<strong>ATTEMPT ${result.attempts[index]}</strong><br>`
    + `Value of playing it: ${formatFinancial(result.marginalValue[index])}<br>`
    + `${result.marginalValue[index] >= 0 ? 'Worth taking' : 'Costs more than it returns'}`);
}

/* 03 — the learning curve */
function drawUncertainLearning(result) {
  const breakEven = result.reference.breakEvenProbability;
  const [, rawMax] = extent(result.probabilityP95, [Number.isFinite(breakEven) ? breakEven : 0]);
  const max = Math.min(1, Math.max(rawMax, 1e-4));
  const frame = plotFrame('uncertain-learning-chart', {
    min: 0, max, dark: true, xLog: true, xMax: result.maxAttempts,
    xTicks: attemptTicks(result.maxAttempts), xTitle: 'ATTEMPT NUMBER  (LOGARITHMIC)',
    yTitle: 'CHANCE OF WINNING THAT ATTEMPT',
    yFormat: value => value === 0 ? '0%'
      : `${(value * 100).toFixed(value < .01 ? 2 : value < .1 ? 1 : 0)}%`
  });
  drawBand(frame, result.coarseAttempts, result.probabilityP05, result.probabilityP95, BAND_OUTER_DARK);
  drawBand(frame, result.coarseAttempts, result.probabilityP25, result.probabilityP75, BAND_INNER_DARK);
  drawSeries(frame, result.coarseAttempts, result.probabilityP50, frame.green, 2.4);
  if (Number.isFinite(breakEven) && breakEven <= max) {
    drawSeries(frame, [1, result.maxAttempts], [breakEven, breakEven], '#fbfbf7', 1.4, [5, 4]);
    chip(frame, 'BREAK EVEN', frame.pad.left, frame.y(breakEven), '#6b7a70');
  }
  drawStopMarker(frame, result.optimal.attempts, '#fbfbf7');

  $('#uncertain-learning-insight').textContent = Number.isFinite(breakEven)
    ? `NEEDS ${(breakEven * 100).toFixed(2)}% TO BREAK EVEN`
    : 'NO BREAK-EVEN CHANCE';
  chartModels['uncertain-learning-chart'] = attemptModel(result, result.coarseAttempts, index =>
    `<strong>ATTEMPT ${result.coarseAttempts[index]}</strong><br>`
    + `Median chance: ${(result.probabilityP50[index] * 100).toFixed(3)}%<br>`
    + `Middle half: ${(result.probabilityP25[index] * 100).toFixed(3)}% to ${(result.probabilityP75[index] * 100).toFixed(3)}%<br>`
    + `Middle 90%: ${(result.probabilityP05[index] * 100).toFixed(3)}% to ${(result.probabilityP95[index] * 100).toFixed(3)}%`);
}

/* 04 — where you might land */
function drawUncertainDistribution(result) {
  const histogram = result.profitHistogram;
  const density = histogram.density;
  const span = histogram.high - histogram.low;
  const binWidth = span / density.length;
  const valueAt = index => histogram.low + (index + .5) * binWidth;

  // The reported range spans the most extreme outcome any drawn universe could
  // produce, which is far wider than where the outcomes actually fall. Plotted
  // whole, every bar collapses into a single spike. So the view is cropped to
  // the bulk of the mass, always keeping zero in frame because the loss/profit
  // boundary is the thing being read off this chart.
  let first = 0;
  let last = density.length - 1;
  let cumulative = 0;
  for (let index = 0; index < density.length; index++) {
    cumulative += density[index];
    if (cumulative > 0.001) { first = index; break; }
  }
  cumulative = 0;
  for (let index = density.length - 1; index >= 0; index--) {
    cumulative += density[index];
    if (cumulative > 0.001) { last = index; break; }
  }
  const zeroBin = Math.round((0 - histogram.low) / binWidth);
  if (zeroBin >= 0 && zeroBin < density.length) {
    first = Math.min(first, zeroBin);
    last = Math.max(last, zeroBin);
  }
  const margin = Math.max(1, Math.round((last - first) * .04));
  first = Math.max(0, first - margin);
  last = Math.min(density.length - 1, last + margin);
  const cropped = first > 0 || last < density.length - 1;
  const viewLow = histogram.low + first * binWidth;
  const viewHigh = histogram.low + (last + 1) * binWidth;

  const peak = Math.max(...density.slice(first, last + 1), 1e-9);
  const frame = plotFrame('uncertain-distribution-chart', {
    min: 0, max: peak * 100, xMin: viewLow, xMax: viewHigh,
    xTicks: niceTicks(viewLow, viewHigh, 4), xFormat: shortNumber,
    xTitle: `WHAT YOU END UP WITH, AFTER ${histogram.attempts} ATTEMPTS`,
    yTitle: 'SHARE OF OUTCOMES', yFormat: value => `${trimZeros(value, 1)}%`
  });
  const { ctx, x, y, pad, plotHeight } = frame;
  const barWidth = frame.plotWidth / (last - first + 1);

  for (let index = first; index <= last; index++) {
    const top = y(density[index] * 100);
    ctx.fillStyle = valueAt(index) >= 0 ? frame.green : LOSS_COLOUR;
    ctx.globalAlpha = .85;
    ctx.fillRect(pad.left + (index - first) * barWidth, top, Math.max(1, barWidth - .3),
      pad.top + plotHeight - top);
  }
  ctx.globalAlpha = 1;
  if (cropped) {
    ctx.font = '8px "DM Mono", monospace';
    ctx.fillStyle = frame.ink;
    ctx.globalAlpha = .5;
    ctx.textAlign = 'right';
    ctx.fillText('RARE EXTREMES TRIMMED', frame.width - pad.right, pad.top + 8);
    ctx.globalAlpha = 1;
    ctx.font = '9px "DM Mono", monospace';
  }

  if (histogram.low < 0 && histogram.high > 0) {
    ctx.strokeStyle = frame.ink;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x(0), pad.top);
    ctx.lineTo(x(0), pad.top + plotHeight);
    ctx.stroke();
    chip(frame, '← LOSS | PROFIT →', x(0), pad.top + 8, frame.ink);
  }
  const median = result.optimal.profitP50;
  if (Number.isFinite(median)) {
    ctx.strokeStyle = '#14251d';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x(median), pad.top);
    ctx.lineTo(x(median), pad.top + plotHeight);
    ctx.stroke();
    ctx.setLineDash([]);
    chip(frame, `TYPICAL ${formatFinancial(median, 0)}`, x(median), pad.top + plotHeight - 10, '#14251d',
      x(median) > frame.width - pad.right - 90 ? 'right' : 'left');
  }

  $('#uncertain-distribution-insight').textContent =
    `${(result.optimal.profitChance * 100).toFixed(1)}% END AHEAD AFTER ${histogram.attempts}`;
  chartModels['uncertain-distribution-chart'] = {
    count: last - first + 1,
    pad: UNCERTAIN_PAD,
    describe: index => {
      const from = histogram.low + (first + index) * binWidth;
      const to = from + binWidth;
      return `<strong>${formatFinancial(from)} to ${formatFinancial(to)}</strong><br>`
        + `Share of outcomes: ${(density[first + index] * 100).toFixed(2)}%<br>`
        + `${from >= 0 ? 'A profit' : 'A loss'}`;
    }
  };
}

/* 05 — chance of ending ahead */
function drawUncertainChance(result) {
  const frame = plotFrame('uncertain-chance-chart', {
    min: 0, max: 1, xLog: true, xMax: result.maxAttempts, xTicks: attemptTicks(result.maxAttempts),
    xTitle: 'ATTEMPTS BEFORE YOU STOP  (LOGARITHMIC)', yTitle: 'CHANCE YOU FINISH IN PROFIT',
    yTicks: [0, .25, .5, .75, 1], yFormat: value => `${(value * 100).toFixed(0)}%`
  });
  drawSeries(frame, result.coarseAttempts, result.profitChance, frame.green, 2.4);
  drawStopMarker(frame, result.optimal.attempts, frame.ink);

  let best = 0;
  result.profitChance.forEach((value, index) => {
    if (value > result.profitChance[best]) best = index;
  });
  const bestAttempt = result.coarseAttempts[best];
  if (bestAttempt !== result.optimal.attempts) {
    drawStopMarker(frame, bestAttempt, '#3f7d5c', `SAFEST ${bestAttempt}`);
  }
  $('#uncertain-chance-insight').textContent =
    `PEAKS AT ${(result.profitChance[best] * 100).toFixed(1)}% NEAR ATTEMPT ${bestAttempt}`;
  chartModels['uncertain-chance-chart'] = attemptModel(result, result.coarseAttempts, index =>
    `<strong>STOP AFTER ${result.coarseAttempts[index]}</strong><br>`
    + `Ends in profit: ${(result.profitChance[index] * 100).toFixed(2)}%<br>`
    + `Median outcome: ${formatFinancial(result.profitP50[index])}`);
}

/* 06 — where the uncertainty comes from */
function drawUncertainVariance(result) {
  const frame = plotFrame('uncertain-variance-chart', {
    min: 0, max: 1, xLog: true, xMax: result.maxAttempts, xTicks: attemptTicks(result.maxAttempts),
    xTitle: 'ATTEMPTS BEFORE YOU STOP  (LOGARITHMIC)', yTitle: 'SHARE OF THE TOTAL RISK',
    yTicks: [0, .25, .5, .75, 1], yFormat: value => `${(value * 100).toFixed(0)}%`
  });
  const { ctx, x, y, pad, plotHeight } = frame;

  // Shares rather than absolute variance: this chart answers where the risk
  // comes from, not how much of it there is.
  const shares = result.attempts.map((attempt, index) => {
    const luck = Math.max(0, result.varianceLuck[index]);
    const parameter = Math.max(0, result.varianceParameter[index]);
    const hyper = Math.max(0, result.varianceHyper[index]);
    const total = luck + parameter + hyper;
    return total > 0 ? [luck / total, parameter / total, hyper / total] : [1, 0, 0];
  });

  const layers = [
    { colour: LOSS_COLOUR, upTo: () => 1, label: 'YOUR ERROR BARS' },
    { colour: frame.green, upTo: share => share[0] + share[1], label: 'THE NUMBERS' },
    { colour: LUCK_COLOUR, upTo: share => share[0], label: 'LUCK' }
  ];
  layers.forEach(layer => {
    ctx.fillStyle = layer.colour;
    ctx.beginPath();
    ctx.moveTo(x(result.attempts[0]), pad.top + plotHeight);
    result.attempts.forEach((attempt, index) => ctx.lineTo(x(attempt), y(layer.upTo(shares[index]))));
    ctx.lineTo(x(result.attempts[result.attempts.length - 1]), pad.top + plotHeight);
    ctx.closePath();
    ctx.fill();
  });

  // Name each band inside itself. The label is placed at the middle of the
  // drawn plot rather than the middle of the data, because a logarithmic axis
  // puts the midpoint of the array far to the right of the midpoint of the pixels.
  const targetX = pad.left + frame.plotWidth * .46;
  let middle = 0;
  result.attempts.forEach((attempt, index) => {
    if (Math.abs(x(attempt) - targetX) < Math.abs(x(result.attempts[middle]) - targetX)) middle = index;
  });
  const share = shares[middle];
  const centres = [share[0] / 2, share[0] + share[1] / 2, share[0] + share[1] + share[2] / 2];
  const names = ['LUCK OF THE GAME', 'NOT KNOWING THE NUMBERS', 'NOT KNOWING YOUR ERROR BARS'];
  const thickness = [share[0], share[1], share[2]];
  ctx.font = '8px "DM Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fbfbf7';
  names.forEach((name, index) => {
    if (thickness[index] < .13) return;
    ctx.fillText(name, targetX, y(centres[index]));
  });
  ctx.font = '9px "DM Mono", monospace';

  drawStopMarker(frame, result.optimal.attempts, '#14251d');
  const optimal = result.optimal;
  const total = optimal.varianceTotal || 1;
  $('#uncertain-variance-insight').textContent =
    `AT THE STOP · ${(optimal.varianceLuck / total * 100).toFixed(0)}% LUCK / `
    + `${((optimal.varianceParameter + optimal.varianceHyper) / total * 100).toFixed(0)}% NOT KNOWING`;
  chartModels['uncertain-variance-chart'] = attemptModel(result, result.attempts, index =>
    `<strong>STOP AFTER ${result.attempts[index]}</strong><br>`
    + `Luck of the game: ${(shares[index][0] * 100).toFixed(1)}%<br>`
    + `Not knowing the numbers: ${(shares[index][1] * 100).toFixed(1)}%<br>`
    + `Not knowing your error bars: ${(shares[index][2] * 100).toFixed(1)}%<br>`
    + `Total spread: ${formatFinancial(Math.sqrt(Math.max(0, result.varianceLuck[index] + result.varianceParameter[index] + result.varianceHyper[index])))}`);
}

/** Horizontal bars with a labelled value axis. */
function horizontalBars(id, rows, options) {
  const chart = getChartContext(id, options.dark);
  const { ctx, width, height, ink, muted } = chart;
  const gutter = 152;
  const pad = { left: gutter, right: 58, top: 16, bottom: 42 };
  const plotWidth = Math.max(40, width - pad.left - pad.right);
  const plotHeight = height - pad.top - pad.bottom;
  const maximum = Math.max(...rows.map(row => Math.abs(row.value)), options.floor ?? 1e-9);
  const ticks = niceTicks(0, maximum, 3);
  const x = value => pad.left + Math.min(1, value / maximum) * plotWidth;

  ctx.font = '9px "DM Mono", monospace';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  ticks.forEach(value => {
    const position = Math.round(x(value)) + .5;
    ctx.strokeStyle = muted;
    ctx.globalAlpha = .25;
    ctx.beginPath();
    ctx.moveTo(position, pad.top);
    ctx.lineTo(position, pad.top + plotHeight);
    ctx.stroke();
    ctx.globalAlpha = .8;
    ctx.fillStyle = ink;
    ctx.fillText((options.format ?? shortNumber)(value), position, pad.top + plotHeight + 7);
  });
  ctx.globalAlpha = .62;
  ctx.fillStyle = ink;
  // Centred on the whole canvas, not the plot: the label gutter pushes the plot
  // far to the right and a long caption would run off the edge.
  if (options.xTitle) ctx.fillText(options.xTitle, width / 2, height - 13);
  ctx.globalAlpha = 1;

  ctx.textBaseline = 'middle';
  const rowHeight = plotHeight / Math.max(1, rows.length);
  rows.forEach((row, index) => {
    const centre = pad.top + rowHeight * (index + .5);
    const barHeight = Math.min(20, rowHeight * .58);
    const length = Math.abs(row.value) / maximum * plotWidth;
    ctx.fillStyle = row.colour ?? chart.green;
    ctx.fillRect(pad.left, centre - barHeight / 2, Math.max(1, length), barHeight);
    ctx.fillStyle = ink;
    ctx.globalAlpha = .85;
    ctx.textAlign = 'right';
    ctx.fillText(row.label, pad.left - 10, centre);
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
    ctx.fillText(row.readout, pad.left + length + 8, centre);
  });

  if (options.reference > 0) {
    const position = x(options.reference);
    ctx.strokeStyle = ink;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(position, pad.top);
    ctx.lineTo(position, pad.top + plotHeight);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/* 07 — which unknown moves the needle */
function drawUncertainSensitivity(result) {
  const ordered = [...result.sensitivity].sort((left, right) => right.share - left.share);
  horizontalBars('uncertain-sensitivity-chart', ordered.map(entry => ({
    label: entry.label,
    value: entry.share,
    readout: `${(entry.share * 100).toFixed(0)}%`,
    colour: entry.spearman >= 0 ? '#16a05d' : LOSS_COLOUR
  })), { xTitle: 'SHARE OF THE INFLUENCE', format: value => `${(value * 100).toFixed(0)}%` });

  const leader = ordered[0];
  $('#uncertain-sensitivity-insight').textContent = leader && leader.share > 0
    ? `${leader.label.toUpperCase()} DRIVES ${(leader.share * 100).toFixed(0)}%`
    : 'NOTHING VARIES';
  chartModels['uncertain-sensitivity-chart'] = {
    count: ordered.length,
    describe: index => `<strong>${ordered[index].label.toUpperCase()}</strong><br>`
      + `Share of influence: ${(ordered[index].share * 100).toFixed(1)}%<br>`
      + `Rank correlation: ${ordered[index].spearman >= 0 ? '+' : ''}${ordered[index].spearman.toFixed(3)}<br>`
      + `${ordered[index].spearman >= 0 ? 'Higher values help you' : 'Higher values hurt you'}`
  };
}

/* 08 — what an answer would be worth */
function drawUncertainInformation(result) {
  const parameters = result.valueOfInformation.parameters;
  const ordered = [...parameters].sort((left, right) => right.value - left.value);
  const perfect = result.valueOfInformation.perfect;
  horizontalBars('uncertain-information-chart', ordered.map(entry => ({
    label: entry.label,
    value: entry.value,
    readout: formatFinancial(entry.value)
  })), {
    reference: perfect,
    floor: Math.max(perfect, 1e-9),
    xTitle: 'WORTH PAYING TO FIND OUT  (DASH = KNOWING EVERYTHING)'
  });

  $('#uncertain-information-insight').textContent =
    `KNOWING EVERYTHING IS WORTH ${formatFinancial(perfect)}`;
  chartModels['uncertain-information-chart'] = {
    count: ordered.length,
    describe: index => `<strong>${ordered[index].label.toUpperCase()}</strong><br>`
      + `Worth learning exactly: ${formatFinancial(ordered[index].value)}<br>`
      + `Knowing every parameter: ${formatFinancial(perfect)}<br>`
      + `<small>The most you should pay to find out</small>`
  };
}

/* 09 — chance of a win against money spent */
function drawUncertainProgress(result) {
  const maximumSpend = Math.max(...result.expectedSpend.filter(Number.isFinite), 1e-9);
  const frame = plotFrame('uncertain-progress-chart', {
    min: 0, max: 1, xLog: true, xMax: result.maxAttempts, xTicks: attemptTicks(result.maxAttempts),
    xTitle: 'ATTEMPTS  (LOGARITHMIC)', yTitle: 'CHANCE OF HAVING WON AT LEAST ONCE',
    yTicks: [0, .25, .5, .75, 1], yFormat: value => `${(value * 100).toFixed(0)}%`
  });
  drawSeries(frame, result.attempts, result.winChance, frame.green, 2.4);
  drawSeries(frame, result.attempts, result.expectedSpend.map(value => value / maximumSpend),
    LOSS_COLOUR, 1.8, [5, 4]);
  drawStopMarker(frame, result.optimal.attempts, frame.ink);

  // The spend line shares the plot on its own scale, so its top is labelled.
  const { ctx, width, pad } = frame;
  ctx.font = '8px "DM Mono", monospace';
  ctx.fillStyle = LOSS_COLOUR;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(`SPEND, TOP = ${formatFinancial(maximumSpend, 0)}`, width - pad.right, pad.top + 8);
  ctx.font = '9px "DM Mono", monospace';

  $('#uncertain-progress-insight').textContent =
    `${(result.optimal.winChance * 100).toFixed(1)}% FOR ${formatFinancial(result.optimal.expectedSpend)}`;
  chartModels['uncertain-progress-chart'] = attemptModel(result, result.attempts, index =>
    `<strong>BY ATTEMPT ${result.attempts[index]}</strong><br>`
    + `Chance of a win: ${(result.winChance[index] * 100).toFixed(2)}%<br>`
    + `Expected spend: ${formatFinancial(result.expectedSpend[index])}<br>`
    + `Expected profit: ${formatFinancial(result.expectedProfit[index])}`);
}

buildBeliefRows();
