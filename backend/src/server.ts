/**
 * Siesta Box Platform — API HTTP + WebSocket
 * KeyCore Tech Hub (CNPJ 42.231.277/0001-75) — "Tecnologia que devolve tempo."
 *
 * Execute: npm run build && npm start
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { randomInt } from 'node:crypto';
import { config } from './config.js';
import { migrate, query, queryOne, waitForDatabase } from './db.js';
import { connectMqtt, mqttConnected, publishCommand } from './mqtt.js';
import { hub } from './hub.js';

const app = Fastify({ logger: { level: config.logLevel } });

await app.register(cors, { origin: true });
await app.register(websocket);

// ── Helpers ────────────────────────────────────────────────────────────────

const PRECOS: Record<number, number> = { 1: 3500, 2: 6000, 4: 10000, 8: 18000 };

function precoPorHoras(horas: number): number {
  if (PRECOS[horas] !== undefined) return PRECOS[horas];
  return Math.round((horas * 2800));
}

function gerarPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

// ── Healthcheck ───────────────────────────────────────────────────────────

app.get('/api/health', async () => {
  let dbOk = false;
  try {
    await query('SELECT 1');
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const unidadesOnline = await query<{ total: string }>(
    "SELECT count(*)::text AS total FROM units WHERE online = TRUE",
  ).catch(() => [{ total: '0' }]);

  const healthy = dbOk;
  return {
    status: healthy ? 'ok' : 'degradado',
    servico: 'siesta-box-platform-api',
    versao: '1.0.0',
    dependencias: { database: dbOk, mqtt: mqttConnected() },
    unidades_online: Number(unidadesOnline[0]?.total ?? 0),
    clientes_websocket: hub.size(),
    timestamp: new Date().toISOString(),
  };
});

// ── Locais (PostGIS) ──────────────────────────────────────────────────────

app.get('/api/locations', async () => {
  return query(
    `SELECT l.id, l.codigo, l.nome, l.tipo, l.endereco,
            ST_Y(l.posicao::geometry) AS lat,
            ST_X(l.posicao::geometry) AS lng,
            count(u.id) FILTER (WHERE u.status = 'disponivel') AS unidades_disponiveis,
            count(u.id) AS unidades_total
     FROM locations l
     LEFT JOIN units u ON u.location_id = l.id
     GROUP BY l.id
     ORDER BY l.codigo`,
  );
});

// ── Unidades ──────────────────────────────────────────────────────────────

app.get('/api/units', async (request) => {
  const { location_id: locationId, status } = request.query as Record<string, string>;
  const filters: string[] = [];
  const params: unknown[] = [];
  if (locationId !== undefined && locationId !== '') {
    params.push(locationId);
    filters.push(`u.location_id = $${params.length}`);
  }
  if (status !== undefined && status !== '') {
    params.push(status);
    filters.push(`u.status = $${params.length}`);
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

  return query(
    `SELECT u.*, l.nome AS local_nome, l.codigo AS local_codigo,
            (SELECT row_to_json(d) FROM (
               SELECT evento, criado_em FROM door_events
               WHERE unit_id = u.id ORDER BY criado_em DESC LIMIT 1
             ) d) AS ultimo_evento_porta
     FROM units u
     LEFT JOIN locations l ON l.id = u.location_id
     ${where}
     ORDER BY u.codigo`,
    params,
  );
});

app.get('/api/units/:codigo', async (request, reply) => {
  const { codigo } = request.params as { codigo: string };
  const unit = await queryOne(
    `SELECT u.*, l.nome AS local_nome,
            ST_Y(l.posicao::geometry) AS lat, ST_X(l.posicao::geometry) AS lng
     FROM units u LEFT JOIN locations l ON l.id = u.location_id
     WHERE u.codigo = $1`,
    [codigo],
  );
  if (unit === null) return reply.code(404).send({ erro: 'unidade_nao_encontrada' });
  return unit;
});

// ── Porta: comandos para a tranca eletrônica (MQTT + ACK) ─────────────────

app.post('/api/units/:codigo/door/:action', async (request, reply) => {
  const { codigo, action } = request.params as { codigo: string; action: string };
  if (!['unlock', 'lock', 'ping'].includes(action)) {
    return reply.code(400).send({ erro: 'acao_invalida', permitidas: ['unlock', 'lock', 'ping'] });
  }

  try {
    const result = await publishCommand(codigo, action, { origin: 'api' });
    const status = result.confirmed ? 200 : 504;
    return reply.code(status).send({
      ...result,
      mensagem: result.confirmed
        ? 'Tranca confirmou a execução em tempo real.'
        : 'Comando publicado, mas o firmware não confirmou dentro do timeout.',
    });
  } catch (error) {
    return reply.code(404).send({ erro: (error as Error).message });
  }
});

app.get('/api/units/:codigo/events', async (request) => {
  const { codigo } = request.params as { codigo: string };
  const unit = await queryOne<{ id: string }>('SELECT id FROM units WHERE codigo = $1', [codigo]);
  if (unit === null) return [];
  return query(
    `SELECT id, evento, origem, detalhes, criado_em FROM door_events
     WHERE unit_id = $1 ORDER BY criado_em DESC LIMIT 50`,
    [unit.id],
  );
});

app.get('/api/units/:codigo/telemetry', async (request) => {
  const { codigo } = request.params as { codigo: string };
  const unit = await queryOne<{ id: string }>('SELECT id FROM units WHERE codigo = $1', [codigo]);
  if (unit === null) return [];
  return query(
    `SELECT temperatura, umidade, bateria, rssi, porta_aberta, trancada, criado_em
     FROM telemetry WHERE unit_id = $1 ORDER BY criado_em DESC LIMIT 100`,
    [unit.id],
  );
});

// ── Reservas + Pix (simulado) + código de acesso ──────────────────────────

app.post('/api/bookings', async (request, reply) => {
  const body = (request.body ?? {}) as {
    unit_codigo?: string;
    horas?: number;
    cliente_nome?: string;
    cliente_doc?: string;
    metodo_pagto?: string;
  };

  if (body.unit_codigo === undefined) {
    return reply.code(400).send({ erro: 'unit_codigo_obrigatorio' });
  }

  const unit = await queryOne<{ id: string; status: string }>(
    'SELECT id, status FROM units WHERE codigo = $1',
    [body.unit_codigo],
  );
  if (unit === null) return reply.code(404).send({ erro: 'unidade_nao_encontrada' });
  if (unit.status !== 'disponivel') {
    return reply.code(409).send({ erro: 'unidade_indisponivel', status_atual: unit.status });
  }

  const horas = Number(body.horas ?? 2);
  const valor = precoPorHoras(horas);
  const txid = `PIX${Date.now()}${randomInt(100, 999)}`;

  const booking = await queryOne<{ id: string }>(
    `INSERT INTO bookings (unit_id, cliente_nome, cliente_doc, horas, valor_centavos, metodo_pagto, status, pix_txid, inicio_em, fim_em)
     VALUES ($1,$2,$3,$4::int,$5,$6,'pago',$7, now(), now() + make_interval(hours => $4::int))
     RETURNING id`,
    [unit.id, body.cliente_nome ?? null, body.cliente_doc ?? null, horas, valor, body.metodo_pagto ?? 'pix', txid],
  );

  const bookingId = booking?.id ?? '';
  const pin = gerarPin();
  const qrPayload = `SIESTABOX|${body.unit_codigo}|${bookingId}|${pin}`;

  await query(
    `INSERT INTO access_codes (booking_id, unit_id, pin, qr_payload, expira_em)
     VALUES ($1,$2,$3,$4, now() + make_interval(hours => $5::int))`,
    [bookingId, unit.id, pin, qrPayload, horas],
  );

  await query(`UPDATE units SET status = 'ocupada', atualizado_em = now() WHERE id = $1`, [unit.id]);
  hub.broadcast({ type: 'status', unit: body.unit_codigo, payload: { status: 'ocupada' } });

  return reply.code(201).send({
    booking_id: bookingId,
    unit_codigo: body.unit_codigo,
    horas,
    valor_centavos: valor,
    valor_formatado: `R$ ${(valor / 100).toFixed(2).replace('.', ',')}`,
    pix: { txid, status: 'pago', simulado: true },
    acesso: { pin, qr_payload: qrPayload },
    inicio_em: new Date().toISOString(),
  });
});

app.post('/api/access/validate', async (request, reply) => {
  const body = (request.body ?? {}) as { pin?: string; qr_payload?: string };
  if (body.pin === undefined && body.qr_payload === undefined) {
    return reply.code(400).send({ erro: 'informe_pin_ou_qr' });
  }

  const row = await queryOne<{ id: string; unit_codigo: string; booking_id: string; expira_em: string; usado: boolean }>(
    `SELECT a.id, u.codigo AS unit_codigo, a.booking_id, a.expira_em, a.usado
     FROM access_codes a JOIN units u ON u.id = a.unit_id
     WHERE a.usado = FALSE
       AND (($1::text IS NOT NULL AND a.pin = $1) OR ($2::text IS NOT NULL AND a.qr_payload = $2))
       AND a.expira_em > now()
     LIMIT 1`,
    [body.pin ?? null, body.qr_payload ?? null],
  );

  if (row === null) return reply.code(403).send({ erro: 'codigo_invalido_ou_expirado' });

  await query('UPDATE access_codes SET usado = TRUE WHERE id = $1', [row.id]);

  const command = await publishCommand(row.unit_codigo, 'unlock', { origin: 'access_code' });

  return {
    autorizado: true,
    unit_codigo: row.unit_codigo,
    booking_id: row.booking_id,
    tranca: command,
  };
});

// ── Dashboard operacional ─────────────────────────────────────────────────

app.get('/api/dashboard', async () => {
  const resumo = await queryOne(
    `SELECT
       count(*)::int AS unidades_total,
       count(*) FILTER (WHERE status = 'disponivel')::int AS disponiveis,
       count(*) FILTER (WHERE status = 'ocupada')::int AS ocupadas,
       count(*) FILTER (WHERE status = 'higienizacao')::int AS higienizacao,
       count(*) FILTER (WHERE status = 'manutencao')::int AS manutencao,
       count(*) FILTER (WHERE online)::int AS online,
       coalesce(round(avg(temperatura), 1), 0) AS temperatura_media,
       coalesce(round(avg(bateria)), 0) AS bateria_media
     FROM units`,
  );

  const latencias = await query(
    `SELECT round(avg(latencia_ms))::int AS media, max(latencia_ms) AS maxima, count(*)::int AS total
     FROM commands WHERE status = 'confirmado' AND criado_em > now() - interval '24 hours'`,
  );

  const eventos = await query(
    `SELECT e.evento, u.codigo AS unit_codigo, e.origem, e.criado_em
     FROM door_events e JOIN units u ON u.id = e.unit_id
     ORDER BY e.criado_em DESC LIMIT 15`,
  );

  const receita = await queryOne<{ centavos: string; reservas: string }>(
    `SELECT coalesce(sum(valor_centavos),0)::text AS centavos, count(*)::text AS reservas
     FROM bookings WHERE status <> 'cancelada'`,
  );

  return {
    resumo,
    latencia_comandos: latencias[0] ?? { media: null, maxima: null, total: 0 },
    eventos_recentes: eventos,
    receita: {
      centavos: Number(receita?.centavos ?? 0),
      reservas: Number(receita?.reservas ?? 0),
    },
  };
});

// ── WebSocket em tempo real ───────────────────────────────────────────────

app.register(async (instance) => {
  instance.get('/ws', { websocket: true }, async (socket) => {
    const send = (data: string): void => {
      if (socket.readyState === 1) socket.send(data);
    };

    hub.add({
      send,
      onClose: (cb) => socket.on('close', cb),
    });

    const units = await query(
      `SELECT codigo, status, trancada, porta_aberta, bateria, temperatura, online, ultimo_heartbeat
       FROM units ORDER BY codigo`,
    ).catch(() => []);
    const events = await query(
      `SELECT e.evento, u.codigo AS unit_codigo, e.criado_em
       FROM door_events e JOIN units u ON u.id = e.unit_id
       ORDER BY e.criado_em DESC LIMIT 10`,
    ).catch(() => []);

    send(JSON.stringify({ type: 'hello', payload: { server_time: new Date().toISOString(), units_online: 0 }, ts: new Date().toISOString() }));
    send(JSON.stringify({ type: 'snapshot', payload: { units, events }, ts: new Date().toISOString() }));

    socket.on('message', (raw: Buffer) => {
      const text = raw.toString();
      if (text === 'ping') send(JSON.stringify({ type: 'pong', ts: new Date().toISOString() }));
    });
  });
});

// ── Bootstrap ─────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  await waitForDatabase();
  await migrate();
  await connectMqtt();

  // Marca como offline quem parou de enviar status/heartbeat.
  setInterval(async () => {
    try {
      await query(
        `UPDATE units SET online = FALSE, status = CASE WHEN status = 'offline' THEN status ELSE 'offline' END
         WHERE online = TRUE AND (ultimo_heartbeat IS NULL OR ultimo_heartbeat < now() - interval '60 seconds')`,
      );
    } catch {
      /* banco momentaneamente indisponível */
    }
  }, 30_000).unref();

  await app.listen({ port: config.port, host: config.host });
  console.log(`
  ╭──────────────────────────────────────────────────────────────╮
  │  Siesta Box Platform API — KeyCore Tech Hub                  │
  │  HTTP  http://${config.host}:${config.port}/api/health
  │  WS    ws://${config.host}:${config.port}/ws
  │  MQTT  ${config.mqttUrl}  (prefixo ${config.mqttPrefix})
  ╰──────────────────────────────────────────────────────────────╯`);
}

bootstrap().catch((error) => {
  console.error('Falha ao iniciar a API:', error);
  process.exit(1);
});
