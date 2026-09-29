/**
 * Configuração central do backend Siesta Box Platform.
 * KeyCore Tech Hub — "Tecnologia que devolve tempo."
 */

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function intEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(env(name, String(fallback)), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: intEnv('PORT', 8080),
  host: env('HOST', '0.0.0.0'),
  logLevel: env('LOG_LEVEL', 'info'),

  databaseUrl: env(
    'DATABASE_URL',
    'postgresql://keycore_admin:keycore_secure_pass_2026@db:5432/siestabox_db',
  ),

  mqttUrl: env('MQTT_URL', 'mqtt://mqtt:1883'),
  mqttPrefix: env('MQTT_PREFIX', 'siestabox'),
  mqttClientId: env('MQTT_CLIENT_ID', `siesta-api-${Math.random().toString(16).slice(2, 8)}`),

  /** Tempo máximo aguardando o ACK da tranca após publicar um comando. */
  ackTimeoutMs: intEnv('ACK_TIMEOUT_MS', 8000),
  /** TTL entregue ao firmware no payload do comando (segurança anti-replay). */
  commandTtlMs: intEnv('COMMAND_TTL_MS', 15000),
};
