/**
 * Simulador de bancada do firmware Siesta Box (ESP32/MicroPython).
 *
 * Emula N módulos falando MQTT exatamente como o firmware real:
 *   - publica telemetria periódica
 *   - publica eventos de porta (aberta/fechada) quando o estado muda
 *   - publica status retained + Last Will (offline)
 *   - reage a `unlock` / `lock` / `ping` e responde `ack` em < 1 s
 *
 * Uso:
 *   npm run sim                      # todas as unidades do banco
 *   UNITS=SB-REC-01,SB-HC-01 npm run sim
 *   MQTT_URL=mqtt://127.0.0.1:1883 DOOR_FLAP=1 npm run sim
 */

import mqtt from 'mqtt';

const MQTT_URL = process.env.MQTT_URL ?? 'mqtt://127.0.0.1:1883';
const PREFIX = process.env.MQTT_PREFIX ?? 'siestabox';
const INTERVAL_S = Number(process.env.TELEMETRY_INTERVAL_S ?? 10);
const DOOR_FLAP = process.env.DOOR_FLAP === '1';
const ONLY = (process.env.UNITS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const DEFAULT_UNITS = [
  'SB-REC-01', 'SB-REC-02', 'SB-REC-03',
  'SB-HC-01', 'SB-HC-02',
  'SB-CC-01', 'SB-CC-02',
  'SB-MZ-01',
];
const UNITS = ONLY.length > 0 ? ONLY : DEFAULT_UNITS;

/** Estado em memória por unidade — espelha as variáveis do main.py. */
function createState(codigo, index) {
  return {
    codigo,
    locked: true,
    doorOpen: false,
    battery: 100 - index * 2,
    temperature: 21 + (index % 4) * 0.5,
    bootedAt: Date.now(),
    nextDoorToggle: Date.now() + (DOOR_FLAP ? 20_000 + index * 3_000 : Number.MAX_SAFE_INTEGER),
  };
}

const states = new Map(UNITS.map((u, i) => [u, createState(u, i)]));
const topic = (codigo, suffix) => `${PREFIX}/${codigo}/${suffix}`;

const root = mqtt.connect(MQTT_URL, {
  clientId: `siesta-sim-${Math.random().toString(16).slice(2, 8)}`,
  reconnectPeriod: 2000,
});

root.on('connect', () => {
  console.log(`[sim] broker ${MQTT_URL} conectado — ${UNITS.length} módulo(s): ${UNITS.join(', ')}`);

  for (const [codigo, state] of states) {
    // Cliente dedicado por unidade: cada um tem seu próprio LWT (queda isolada).
    const device = mqtt.connect(MQTT_URL, {
      clientId: `siesta-fw-${codigo}-${Math.random().toString(16).slice(2, 6)}`,
      will: {
        topic: topic(codigo, 'status'),
        payload: JSON.stringify({ online: false, unit: codigo }),
        retain: true,
        qos: 1,
      },
    });

    device.on('connect', () => {
      device.subscribe(topic(codigo, 'cmd'), { qos: 1 });
      device.publish(
        topic(codigo, 'status'),
        JSON.stringify({ online: true, unit: codigo, firmware: '1.0.0-sim' }),
        { retain: true, qos: 1 },
      );
      console.log(`[sim] ${codigo} online`);
    });

    device.on('message', (_t, buffer) => {
      let payload = {};
      try {
        payload = JSON.parse(buffer.toString());
      } catch {
        payload = {};
      }
      handleCommand(codigo, state, payload, device);
    });

    device.on('error', (err) => console.error(`[sim] ${codigo} erro:`, err.message));

    setInterval(() => publishTelemetry(codigo, state, device), INTERVAL_S * 1000);
    setInterval(() => maybeToggleDoor(codigo, state, device), 1000);
    setTimeout(() => publishTelemetry(codigo, state, device), 500 + Math.random() * 1000);
  }
});

root.on('error', (err) => console.error('[sim] erro no broker raiz:', err.message));

function publishTelemetry(codigo, state, device) {
  state.battery = Math.max(15, state.battery - 0.05);
  state.temperature = Math.round((20.5 + Math.sin(Date.now() / 60_000) * 2.5) * 10) / 10;

  device.publish(
    topic(codigo, 'telemetry'),
    JSON.stringify({
      unit: codigo,
      temperature: state.temperature,
      humidity: 52 + Math.round(Math.abs(Math.sin(Date.now() / 90_000)) * 12),
      battery: Math.round(state.battery),
      rssi: -55 - Math.round(Math.random() * 12),
      door_open: state.doorOpen,
      locked: state.locked,
      uptime_s: Math.round((Date.now() - state.bootedAt) / 1000),
      firmware: '1.0.0-sim',
    }),
    { qos: 1 },
  );
}

function maybeToggleDoor(codigo, state, device) {
  if (Date.now() < state.nextDoorToggle) return;
  state.doorOpen = !state.doorOpen;
  if (state.doorOpen) state.locked = false;
  state.nextDoorToggle = Date.now() + 25_000 + Math.random() * 30_000;

  console.log(`[sim] ${codigo} porta ${state.doorOpen ? 'ABERTA' : 'FECHADA'}`);
  device.publish(
    topic(codigo, 'door'),
    JSON.stringify({ unit: codigo, event: state.doorOpen ? 'aberta' : 'fechada', origin: 'sensor' }),
    { qos: 1 },
  );
  if (!state.doorOpen && state.locked) {
    device.publish(topic(codigo, 'door'), JSON.stringify({ unit: codigo, event: 'travada', origin: 'autolock' }), { qos: 1 });
  }
}

function handleCommand(codigo, state, payload, device) {
  const action = payload.action;
  const commandId = payload.command_id;
  console.log(`[sim] ${codigo} ← comando ${action} (${commandId})`);

  // Latência de bancada: 80–320 ms, como uma tranca real responderia.
  const latency = 80 + Math.random() * 240;
  let ok = true;
  let detail = action;

  setTimeout(() => {
    if (action === 'unlock') {
      state.locked = false;
      state.doorOpen = true;
      device.publish(topic(codigo, 'door'), JSON.stringify({ unit: codigo, event: 'destravada', origin: 'command' }), { qos: 1 });
      device.publish(topic(codigo, 'door'), JSON.stringify({ unit: codigo, event: 'aberta', origin: 'command' }), { qos: 1 });
    } else if (action === 'lock') {
      state.locked = true;
      state.doorOpen = false;
      device.publish(topic(codigo, 'door'), JSON.stringify({ unit: codigo, event: 'fechada', origin: 'command' }), { qos: 1 });
      device.publish(topic(codigo, 'door'), JSON.stringify({ unit: codigo, event: 'travada', origin: 'command' }), { qos: 1 });
    } else if (action === 'ping') {
      detail = 'pong';
    } else {
      ok = false;
      detail = 'acao_desconhecida';
    }

    device.publish(
      topic(codigo, 'ack'),
      JSON.stringify({
        command_id: commandId,
        unit: codigo,
        ok,
        action,
        detail,
        locked: state.locked,
        door_open: state.doorOpen,
        latency_ms: Math.round(latency),
      }),
      { qos: 1 },
    );
    publishTelemetry(codigo, state, device);
  }, latency);
}

process.on('SIGINT', () => {
  console.log('\n[sim] encerrando módulos (LWT publica offline)...');
  process.exit(0);
});
