const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

const HTTP_PORT = 3000;
const WS_PORT = 3001;
const RL_WS_URL = 'ws://localhost:49122';
const RL_RECONNECT_INTERVAL = 3000;

let appDir = __dirname;
let dataDir;
let teamsFile;

// ─── State ───────────────────────────────────────────────────────────────────
let state = {
  view: 'hud',              // 'hud' | 'scoreboard' | 'goal'
  eventName: 'ROCKET LEAGUE TOURNAMENT',
  bestOf: 5,
  teams: {
    blue:   { name: 'BLUE TEAM',   logo: null },
    orange: { name: 'ORANGE TEAM', logo: null }
  },
  series:  { blue: 0, orange: 0 },
  game:    { blueScore: 0, orangeScore: 0, time: 300, isOT: false, number: 0 },
  gameTeams: { blue: '', orange: '' },
  players: [],          // active players (from last UpdateState)
  playerCache: {},      // all players seen (keyed by name) — for scoreboard
  currentGoal: null,    // { scorer, assister, speed, team }
  spectatedPlayer: null,
  rlConnected: false
};

let savedTeams = [];   // [{ name, logo }]

// ─── Helpers ─────────────────────────────────────────────────────────────────
function loadTeams() {
  try {
    if (fs.existsSync(teamsFile)) {
      savedTeams = JSON.parse(fs.readFileSync(teamsFile, 'utf8'));
    }
  } catch (e) { savedTeams = []; }
}

function saveTeams() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(teamsFile, JSON.stringify(savedTeams, null, 2));
  } catch (e) { console.error('Error saving teams:', e); }
}

function broadcast(clients, msg) {
  const str = JSON.stringify(msg);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(str);
  });
}

function formatTime(seconds) {
  if (seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function getFullState() {
  return {
    type: 'full_state',
    data: {
      ...state,
      savedTeams,
      formattedTime: formatTime(state.game.time)
    }
  };
}

// ─── RL TCP Client ─────────────────────────────────────────────────────────────
const net = require('net');
let rlSocket = null;
let bridgeClients = new Set();
let rlBuffer = '';

function connectToRL() {
  if (rlSocket) return;
  
  rlSocket = new net.Socket();
  
  rlSocket.connect(49123, '127.0.0.1', () => {
    console.log('[RL] Connected to Stats API (TCP)');
    state.rlConnected = true;
    broadcast(bridgeClients, { type: 'rl_status', data: { connected: true } });
  });

  rlSocket.on('data', (data) => {
    rlBuffer += data.toString();
    
    // Split by contiguous JSON objects
    const chunks = rlBuffer.replace(/\}\s*\{/g, '}\n{').split('\n');
    rlBuffer = chunks.pop(); // keep the last incomplete chunk
    
    chunks.forEach(chunk => {
      chunk = chunk.trim();
      if (!chunk) return;
      try {
        const msg = JSON.parse(chunk);
        handleRLEvent(msg);
      } catch (e) {
        // If it fails to parse, it might be incomplete. We should prepend it back.
        // But since we split by }\n{, it should be complete unless the split failed.
        // For simplicity, we just ignore broken packets.
      }
    });
  });

  rlSocket.on('close', () => {
    console.log('[RL] Disconnected from Stats API');
    state.rlConnected = false;
    rlSocket = null;
    broadcast(bridgeClients, { type: 'rl_status', data: { connected: false } });
    scheduleRLReconnect();
  });

  rlSocket.on('error', () => {
    rlSocket = null;
    scheduleRLReconnect();
  });
}

function scheduleRLReconnect() {
  setTimeout(connectToRL, RL_RECONNECT_INTERVAL);
}

function handleRLEvent(msg) {
  const event = msg.Event || msg.event || '';
  let data  = msg.Data  || msg.data  || {};

  // DefaultStatsAPI sometimes stringifies the Data field
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (e) { }
  }

  switch (event) {
    case 'UpdateState':
    case 'game:update_state':
      handleUpdateState(data);
      break;
    case 'GoalScored':
    case 'game:goal_scored':
      handleGoalScored(data);
      break;
    case 'ClockUpdatedSeconds':
      handleClock(data);
      break;
    case 'GoalReplayStart':
    case 'ReplayStart':
    case 'game:replay_start':
      handleGoalReplayStart();
      break;
    case 'GoalReplayEnd':
    case 'ReplayEnd':
    case 'game:replay_end':
      handleGoalReplayEnd();
      break;
    case 'MatchEnded':
    case 'game:match_ended':
      handleMatchEnded(data);
      break;
    case 'MatchCreated':
    case 'game:match_created':
      handleMatchCreated(data);
      break;
    default:
      break;
  }
}

function handleClock(data) {
  if ('TimeSeconds' in data) state.game.time = data.TimeSeconds;
  else if ('time_seconds' in data) state.game.time = data.time_seconds;
  
  if ('bOvertime' in data) state.game.isOT = data.bOvertime;
  
  // If the clock ticks, we are definitely not in a replay anymore.
  if (state.view === 'goal') {
    handleGoalReplayEnd();
  }

  // Broadcast the new time to clients
  broadcast(bridgeClients, {
    type: 'state_update',
    data: {
      game: { ...state.game, formattedTime: formatTime(state.game.time) },
      players: state.players,
      spectatedPlayer: state.spectatedPlayer
    }
  });
}

function handleUpdateState(data) {
  const game = data.Game || data.game || {};
  const players = data.Players || data.players || [];

  // Update game
  if ('SecondsRemaining' in game) state.game.time = game.SecondsRemaining;
  else if ('time_seconds' in game) state.game.time = game.time_seconds;
  
  if ('IsOT' in game) state.game.isOT = game.IsOT;
  else if ('isOT' in game) state.game.isOT = game.isOT;

  // Scores from teams array or direct fields
  const teams = game.Teams || game.teams || [];
  if (teams.length >= 2) {
    teams.forEach(t => {
      if ((t.TeamNum === 0 || t.teamNum === 0)) {
        state.game.blueScore   = t.Score ?? t.score ?? 0;
        state.gameTeams.blue   = t.Name || t.name || 'BLUE';
      }
      if ((t.TeamNum === 1 || t.teamNum === 1)) {
        state.game.orangeScore = t.Score ?? t.score ?? 0;
        state.gameTeams.orange = t.Name || t.name || 'ORANGE';
      }
    });
  } else {
    if ('BlueScore'   in game) state.game.blueScore   = game.BlueScore;
    if ('OrangeScore' in game) state.game.orangeScore = game.OrangeScore;
  }

  // Players — normalise field names
  const normalised = players.map(p => ({
    name:    p.Name    || p.name    || '?',
    team:    p.TeamNum ?? p.teamNum ?? 0,
    score:   p.Score   ?? p.score   ?? 0,
    goals:   p.Goals   ?? p.goals   ?? 0,
    assists: p.Assists ?? p.assists ?? 0,
    saves:   p.Saves   ?? p.saves   ?? 0,
    shots:   p.Shots   ?? p.shots   ?? 0,
    boost:   p.Boost   ?? p.boost   ?? null,
    isPrimary: p.IsPrimary ?? p.isPrimary ?? false,
    isDemolished: p.bDemolished ?? p.isDemolished ?? false
  }));

  state.players = normalised;

  // Update playerCache (persist players across game/disconnect)
  normalised.forEach(p => {
    state.playerCache[p.name] = { ...p };
  });

  // Detect spectated player
  let spec = null;
  if (game.bHasTarget !== false && game.Target) {
    spec = game.Target.Name || game.Target.name || null;
  }
  
  if (spec) {
    state.spectatedPlayer = spec;
  } else {
    // fallback to isPrimary
    const primary = normalised.find(p => p.isPrimary);
    if (primary) state.spectatedPlayer = primary.name;
    else state.spectatedPlayer = null;
  }

  // Detect transition to replay to trigger goal banner if not already shown
  if (game.bReplay === true && !state.inReplay && state.currentGoal && state.view !== 'goal') {
    handleGoalReplayStart();
  }

  // Track replay state so we don't prematurely close the goal banner
  if (game.bReplay === true) {
    state.inReplay = true;
  } else if (game.bReplay === false && state.inReplay) {
    state.inReplay = false;
    if (state.view === 'goal') {
      handleGoalReplayEnd();
    }
  }

  // Broadcast state to all clients
  broadcast(bridgeClients, {
    type: 'state_update',
    data: {
      game: { ...state.game, formattedTime: formatTime(state.game.time) },
      players: normalised,
      spectatedPlayer: state.spectatedPlayer
    }
  });
}

function handleGoalScored(data) {
  const scorer   = data.Scorer   || data.scorer   || {};
  const assister = data.Assister || data.assister || null;
  const speed    = data.GoalSpeedKPH ?? data.goalSpeedKPH ?? data.GoalSpeed ?? data.goalSpeed ?? 0;
  const team     = scorer.TeamNum ?? scorer.teamNum ?? scorer.team ?? data.teamnum ?? 0;

  state.currentGoal = {
    scorer:   scorer.Name   || scorer.name   || '',
    assisterName: assister ? (assister.Name || assister.name || '') : null,
    speed:    Math.round(speed),
    team:     team
  };
}

function handleGoalReplayStart() {
  if (state.currentGoal) {
    state.view = 'goal';
    broadcast(bridgeClients, { type: 'view_change', data: { view: 'goal', goal: state.currentGoal } });
  }
}

function handleGoalReplayEnd() {
  state.view = 'hud';
  state.currentGoal = null;
  broadcast(bridgeClients, { type: 'view_change', data: { view: 'hud' } });
}

function handleMatchEnded(data) {
  // Determine winner by score (more reliable than relying on potentially missing fields)
  if (state.game.blueScore > state.game.orangeScore) {
    state.series.blue++;
  } else if (state.game.orangeScore > state.game.blueScore) {
    state.series.orange++;
  }
  
  broadcastFullState();

  setTimeout(() => {
    // Freeze playerCache as final scoreboard data
    state.view = 'scoreboard';
    broadcast(bridgeClients, {
      type: 'view_change',
      data: {
        view: 'scoreboard',
        series: state.series,
        playerCache: state.playerCache
      }
    });
  }, 3000);
}

function handleMatchCreated(data) {
  // New game starts — reset game data but keep series
  state.game.blueScore   = 0;
  state.game.orangeScore = 0;
  state.game.time        = 300;
  state.game.isOT        = false;
  state.game.number++;
  state.players    = [];
  state.playerCache = {};
  state.view       = 'hud';
  broadcastFullState();
  broadcast(bridgeClients, { type: 'game_reset', data: { gameNumber: state.game.number } });
}

// ─── WS Bridge Server (port 3001) ────────────────────────────────────────────
function startBridgeServer() {
  const wss = new WebSocket.Server({ port: WS_PORT });

  wss.on('connection', (ws) => {
    bridgeClients.add(ws);
    // Send full state immediately on connect
    ws.send(JSON.stringify(getFullState()));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleControlMessage(msg, ws);
      } catch (e) { /* ignore */ }
    });

    ws.on('close', () => bridgeClients.delete(ws));
    ws.on('error', () => bridgeClients.delete(ws));
  });

  console.log(`[Bridge] WS server on :${WS_PORT}`);
}

function handleControlMessage(msg, ws) {
  switch (msg.type) {
    case 'set_event_name':
      state.eventName = msg.data.name || '';
      broadcastFullState();
      break;

    case 'set_team':
      if (msg.data.side === 'blue' || msg.data.side === 'orange') {
        state.teams[msg.data.side] = {
          name: msg.data.name || '',
          logo: msg.data.logo || null
        };
        broadcastFullState();
      }
      break;

    case 'adjust_series':
      if (msg.data.side === 'blue' || msg.data.side === 'orange') {
        state.series[msg.data.side] = Math.max(0, state.series[msg.data.side] + (msg.data.delta || 0));
        broadcastFullState();
      }
      break;

    case 'set_series':
      if (typeof msg.data.blue === 'number') state.series.blue   = Math.max(0, msg.data.blue);
      if (typeof msg.data.orange === 'number') state.series.orange = Math.max(0, msg.data.orange);
      broadcastFullState();
      break;

    case 'set_best_of':
      state.bestOf = msg.data.value || 5;
      broadcastFullState();
      break;

    case 'adjust_game_number':
      state.game.number = Math.max(0, state.game.number + (msg.data.delta || 0));
      broadcastFullState();
      break;

    case 'set_game_number':
      state.game.number = Math.max(0, msg.data.value ?? 0);
      broadcastFullState();
      break;

    case 'force_scoreboard':
      state.view = 'scoreboard';
      broadcast(bridgeClients, { type: 'view_change', data: { view: 'scoreboard', playerCache: state.playerCache } });
      break;

    case 'force_hud':
      state.view = 'hud';
      broadcast(bridgeClients, { type: 'view_change', data: { view: 'hud' } });
      break;

    case 'save_team': {
      const { name, logo } = msg.data;
      const idx = savedTeams.findIndex(t => t.name === name);
      if (idx >= 0) savedTeams[idx] = { name, logo };
      else savedTeams.push({ name, logo });
      saveTeams();
      broadcastFullState();
      break;
    }

    case 'delete_team': {
      savedTeams = savedTeams.filter(t => t.name !== msg.data.name);
      saveTeams();
      broadcastFullState();
      break;
    }

    case 'request_state':
      ws.send(JSON.stringify(getFullState()));
      break;

    default:
      break;
  }
}

function broadcastFullState() {
  broadcast(bridgeClients, getFullState());
}

// ─── HTTP Server (port 3000) — serves overlay ────────────────────────────────
function startHttpServer(baseDir) {
  const app = express();

  // Serve overlay at root
  app.use(express.static(path.join(baseDir, 'overlay')));

  // Serve assets
  app.use('/assets', express.static(path.join(baseDir, 'assets')));

  // Serve team logos from userData data dir
  app.use('/data', express.static(dataDir));

  app.listen(HTTP_PORT, '127.0.0.1', () => {
    console.log(`[HTTP] Overlay at http://localhost:${HTTP_PORT}`);
  });
}

// ─── Start ───────────────────────────────────────────────────────────────────
module.exports.start = function(baseDir) {
  appDir = baseDir || __dirname;

  // Data paths — use userData so teams survive portable exe relocation
  const { app: electronApp } = require('electron');
  const userData = electronApp.getPath('userData');
  dataDir   = path.join(userData, 'data');
  teamsFile = path.join(dataDir, 'teams.json');

  fs.mkdirSync(dataDir, { recursive: true });
  loadTeams();

  startHttpServer(appDir);
  startBridgeServer();
  connectToRL();
};
