/**
 * Ponte MQTT ⇄ API ⇄ PostgreSQL.
 *
 * Tópicos (prefixo configurável via MQTT_PREFIX):
 *   siestabox/<unidade>/telemetry   firmware → API   temperatura, bateria, rssi
 *   siestabox/<unidade>/door        firmware → API   aberta | fechada | destravada | travada
 *   siestabox/<unidade>/status      firmware → API   online (retained, com LWT offline)
 *   siestabox/<unidade>/cmd         API → firmware   unlock | lock | ar_set | ping
 *   siestabox/<unidade>/ack         firmware → API   confirmação do comando (< 1s)
 */

import mqtt, { type MqttClient } from 'mqtt';
import { config } from './config.js';
import { query, queryOne } from './db.js';
import { hub } from './hub.js';

type UnitRow = { id: string; codigo: string; status: string };

let client: MqttClient | null = null;
const pending = new Map<string, { resolve: (v: boolean) => void; timer: NodeJS.Timeout }>();

const topic = (codigo: string, suffix: string): string =>
  `${config.mqttPrefix}/${codigo}/${suffix}`;

async function resolveUnit(codigo: string): Promise<UnitRow | null> {
  return queryOne<UnitRow>('SELECT id, codigo, status FROM units WHERE codigo = $1', [codigo]);
}

export async function connectMqtt(): Promise<MqttClient> {
  if (client !== null) return client;

  client = mqtt.connect(config.mqttUrl, {
    clientId: config.mqttClientId,
    clean: true,
    reconnectPeriod: 2000,
    connectTimeout: 10_000,
  });

  client.on('connect', () => {
    console.log(`[mqtt] conectado em ${config.mqttUrl}`);
    client?.subscribe(`${config.mqttPrefix}/+/+`, { qos: 1 }, (err) => {
      if (err) console.error('[mqtt] falha ao assinar tópicos:', err.message);
      else console.log(`[mqtt] assinando ${config.mqttPrefix}/+/+`);
    });
  });

  client.on('error', (err) => console.error('[mqtt] erro:', err.message));

  client.on('message', (topicName, buffer) => {
    const parts = topicName.split('/');
    if (parts.length !== 3) return;
    const [, codigo, suffix] = parts;
    void handleMessage(codigo, suffix, buffer.toString());
  });

  return client;
}

async function handleMessage(codigo: string, suffix: string, raw: string): Promise<void> {
  let payload: Record<string, unknown> = {};
  try {
    payload = raw.trim() === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
  } catch {
    payload = { raw };
  }

  const unit = await resolveUnit(codigo);
  if (unit === null) return; // unidade desconhecida: ignora sem poluir o banco

  if (suffix === 'telemetry') {
    await query(
      `INSERT INTO telemetry (unit_id, temperatura, umidade, bateria, rssi, porta_aberta, trancada, uptime_s, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        unit.id,
        payload.temperature ?? null,
        payload.humidity ?? null,
        payload.battery ?? null,
        payload.rssi ?? null,
        payload.door_open ?? null,
        payload.locked ?? null,
        payload.uptime_s ?? null,
        JSON.stringify(payload),
      ],
    );
    await query(
      `UPDATE units SET
         temperatura = COALESCE($2, temperatura),
         umidade     = COALESCE($3, umidade),
         bateria     = COALESCE($4, bateria),
         rssi        = COALESCE($5, rssi),
         porta_aberta= COALESCE($6, porta_aberta),
         trancada    = COALESCE($7, trancada),
         online      = TRUE,
         firmware_versao = COALESCE($8, firmware_versao),
         ultimo_heartbeat = now(),
         atualizado_em = now()
       WHERE id = $1`,
      [
        unit.id,
        payload.temperature ?? null,
        payload.humidity ?? null,
        payload.battery ?? null,
        payload.rssi ?? null,
        payload.door_open ?? null,
        payload.locked ?? null,
        payload.firmware ?? null,
      ],
    );
    hub.broadcast({ type: 'telemetry', unit: codigo, payload });
    return;
  }

  if (suffix === 'door') {
    const evento = String(payload.event ?? payload.evento ?? 'desconhecido');
    const trancada = evento === 'travada' ? true : evento === 'destravada' ? false : null;
    const aberta = evento === 'aberta' ? true : evento === 'fechada' ? false : null;

    await query(
      `INSERT INTO door_events (unit_id, evento, origem, detalhes) VALUES ($1,$2,$3,$4)`,
      [unit.id, evento, String(payload.origin ?? 'firmware'), JSON.stringify(payload)],
    );
    await query(
      `UPDATE units SET
         trancada     = COALESCE($2, trancada),
         porta_aberta = COALESCE($3, porta_aberta),
         online       = TRUE,
         ultimo_heartbeat = now(),
         atualizado_em = now()
       WHERE id = $1`,
      [unit.id, trancada, aberta],
    );

    console.log(`[door] ${codigo} → ${evento}`);
    hub.broadcast({ type: 'door', unit: codigo, payload: { ...payload, event: evento } });
    return;
  }

  if (suffix === 'status') {
    const online = payload.online !== false;
    await query(
      `UPDATE units SET online = $2, ultimo_heartbeat = now(), atualizado_em = now() WHERE id = $1`,
      [unit.id, online],
    );
    if (online) {
      await query(
        `UPDATE units SET status = CASE WHEN status = 'offline' THEN 'disponivel' ELSE status END WHERE id = $1`,
        [unit.id],
      );
    } else {
      await query(`UPDATE units SET status = 'offline' WHERE id = $1`, [unit.id]);
    }
    hub.broadcast({ type: 'status', unit: codigo, payload: { ...payload, online } });
    return;
  }

  if (suffix === 'ack') {
    const commandId = String(payload.command_id ?? payload.id ?? '');
    if (commandId === '') return;

    const existing = await queryOne<{ criado_em: string; status: string }>(
      'SELECT criado_em, status FROM commands WHERE id = $1',
      [commandId],
    );
    const latency =
      existing !== null
        ? Math.round(Date.now() - new Date(existing.criado_em).getTime())
        : null;

    await query(
      `UPDATE commands SET status = $2, ack_payload = $3, latencia_ms = $4, confirmado_em = now()
       WHERE id = $1`,
      [commandId, payload.ok === false ? 'erro' : 'confirmado', JSON.stringify(payload), latency],
    );

    const waiter = pending.get(commandId);
    if (waiter !== undefined) {
      clearTimeout(waiter.timer);
      pending.delete(commandId);
      waiter.resolve(payload.ok !== false);
    }

    console.log(`[ack] ${codigo} cmd=${commandId} latência=${latency ?? '?'}ms`);
    hub.broadcast({ type: 'ack', unit: codigo, payload: { ...payload, command_id: commandId, latency_ms: latency } });
  }
}

export type CommandResult = {
  command_id: string;
  unit: string;
  action: string;
  confirmed: boolean;
  latency_ms: number | null;
};

/** Publica um comando na tranca e aguarda o ACK do firmware até o timeout. */
export async function publishCommand(
  codigo: string,
  action: string,
  extra: Record<string, unknown> = {},
): Promise<CommandResult> {
  const unit = await resolveUnit(codigo);
  if (unit === null) throw new Error(`Unidade não encontrada: ${codigo}`);

  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO commands (unit_id, action, payload, solicitado_por)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [unit.id, action, JSON.stringify(extra), String(extra.origin ?? 'api')],
  );
  const commandId = inserted?.id ?? '';

  const envelope = {
    command_id: commandId,
    action,
    unit: codigo,
    ttl_ms: config.commandTtlMs,
    issued_at: new Date().toISOString(),
    ...extra,
  };

  hub.broadcast({ type: 'command', unit: codigo, payload: envelope });

  const delivered = client !== null && client.connected;
  if (!delivered) {
    await query(`UPDATE commands SET status = 'erro', ack_payload = $2 WHERE id = $1`, [
      commandId,
      JSON.stringify({ error: 'broker_mqtt_offline' }),
    ]);
    return { command_id: commandId, unit: codigo, action, confirmed: false, latency_ms: null };
  }

  client?.publish(topic(codigo, 'cmd'), JSON.stringify(envelope), { qos: 1 });

  const confirmed = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(commandId);
      resolve(false);
    }, config.ackTimeoutMs);
    pending.set(commandId, { resolve, timer });
  });

  if (!confirmed) {
    await query(
      `UPDATE commands SET status = 'timeout' WHERE id = $1 AND status = 'pendente'`,
      [commandId],
    );
  }

  const row = await queryOne<{ latencia_ms: number | null; status: string }>(
    'SELECT latencia_ms, status FROM commands WHERE id = $1',
    [commandId],
  );

  return {
    command_id: commandId,
    unit: codigo,
    action,
    confirmed: row?.status === 'confirmado',
    latency_ms: row?.latencia_ms ?? null,
  };
}

export function mqttConnected(): boolean {
  return client !== null && client.connected;
}
