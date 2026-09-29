-- ============================================================================
-- Siesta Box Platform — schema PostgreSQL + PostGIS
-- KeyCore Tech Hub (CNPJ 42.231.277/0001-75)
-- Idempotente: pode ser executado em toda inicialização do container.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Locais de operação (geoespacial) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS locations (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo       VARCHAR(32) UNIQUE NOT NULL,
    nome         TEXT NOT NULL,
    tipo         VARCHAR(32) NOT NULL,          -- aeroporto | hospital | evento | congresso | corporativo
    endereco     TEXT,
    posicao      GEOGRAPHY(Point, 4326),
    criado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_locations_posicao ON locations USING GIST (posicao);

-- ── Unidades (módulos habitacionais itinerantes) ───────────────────────────
CREATE TABLE IF NOT EXISTS units (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo            VARCHAR(32) UNIQUE NOT NULL,      -- ex.: SB-REC-01
    location_id       UUID REFERENCES locations(id) ON DELETE SET NULL,
    status            VARCHAR(24) NOT NULL DEFAULT 'disponivel',
                      -- disponivel | ocupada | higienizacao | manutencao | offline
    trancada          BOOLEAN NOT NULL DEFAULT TRUE,
    porta_aberta      BOOLEAN NOT NULL DEFAULT FALSE,
    bateria           INT NOT NULL DEFAULT 100,
    temperatura       NUMERIC(4,1),
    umidade           INT,
    ar_setpoint       NUMERIC(3,1) NOT NULL DEFAULT 22.0,
    rssi              INT,
    firmware_versao   VARCHAR(16),
    online            BOOLEAN NOT NULL DEFAULT FALSE,
    ultimo_heartbeat  TIMESTAMPTZ,
    atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Reservas e códigos de acesso ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bookings (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    unit_id        UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    cliente_nome   TEXT,
    cliente_doc    TEXT,
    horas          INT NOT NULL,
    valor_centavos INT NOT NULL,
    metodo_pagto   VARCHAR(16) NOT NULL DEFAULT 'pix',
    status         VARCHAR(16) NOT NULL DEFAULT 'pendente',   -- pendente | pago | em_uso | encerrada | cancelada
    pix_txid       VARCHAR(64),
    inicio_em      TIMESTAMPTZ,
    fim_em         TIMESTAMPTZ,
    criado_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS access_codes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id  UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    unit_id     UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    pin         CHAR(6) NOT NULL,
    qr_payload  TEXT NOT NULL,
    usado       BOOLEAN NOT NULL DEFAULT FALSE,
    expira_em   TIMESTAMPTZ NOT NULL,
    criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_access_lookup ON access_codes (pin) WHERE usado = FALSE;

-- ── Comandos enviados ao firmware (tranca) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS commands (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    unit_id      UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    action       VARCHAR(16) NOT NULL,          -- unlock | lock | ar_set | ping
    payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
    status       VARCHAR(16) NOT NULL DEFAULT 'pendente',  -- pendente | confirmado | timeout | erro
    ack_payload  JSONB,
    latencia_ms  INT,
    solicitado_por TEXT DEFAULT 'api',
    criado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmado_em TIMESTAMPTZ
);

-- ── Eventos de porta (abertura/fechamento notificados pelo firmware) ───────
CREATE TABLE IF NOT EXISTS door_events (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    unit_id    UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    evento     VARCHAR(24) NOT NULL,            -- aberta | fechada | destravada | travada | ack_manual
    origem     VARCHAR(16) NOT NULL DEFAULT 'firmware',
    detalhes   JSONB,
    criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_door_events_unit ON door_events (unit_id, criado_em DESC);

-- ── Telemetria bruta (histórico para manutenção preditiva) ─────────────────
CREATE TABLE IF NOT EXISTS telemetry (
    id          BIGSERIAL PRIMARY KEY,
    unit_id     UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    temperatura NUMERIC(4,1),
    umidade     INT,
    bateria     INT,
    rssi        INT,
    porta_aberta BOOLEAN,
    trancada    BOOLEAN,
    uptime_s    INT,
    payload     JSONB,
    criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telemetry_unit ON telemetry (unit_id, criado_em DESC);

-- ── Seed de demonstração (Recife) ──────────────────────────────────────────
INSERT INTO locations (codigo, nome, tipo, endereco, posicao) VALUES
  ('REC-AER', 'Aeroporto Internacional dos Guararapes (SBRF)', 'aeroporto', 'Praça Min. Salgado Filho, Recife - PE', ST_SetSRID(ST_MakePoint(-34.9228, -8.1264), 4326)::geography),
  ('REC-HC',  'Hospital das Clínicas da UFPE', 'hospital', 'Av. Prof. Moraes Rego, 1235 - Cidade Universitária', ST_SetSRID(ST_MakePoint(-34.9515, -8.0469), 4326)::geography),
  ('REC-CC',  'Centro de Convenções de Pernambuco', 'congresso', 'Av. Prof. Andrade Bezerra, s/n - Salgadinho, Olinda', ST_SetSRID(ST_MakePoint(-34.8715, -8.0312), 4326)::geography),
  ('REC-MZ',  'Marco Zero / Recife Antigo', 'evento', 'Praça Rio Branco, Recife - PE', ST_SetSRID(ST_MakePoint(-34.8711, -8.0631), 4326)::geography)
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO units (codigo, location_id, status, bateria, temperatura, ar_setpoint, firmware_versao)
SELECT v.codigo, l.id, v.status, v.bateria, v.temperatura, v.setpoint, v.fw
FROM (VALUES
  ('SB-REC-01', 'REC-AER', 'disponivel',   98, 21.5, 22.0, '1.0.0'),
  ('SB-REC-02', 'REC-AER', 'ocupada',      89, 22.1, 21.0, '1.0.0'),
  ('SB-REC-03', 'REC-AER', 'disponivel',  100, 20.8, 22.0, '1.0.0'),
  ('SB-HC-01',  'REC-HC',  'disponivel',   94, 22.0, 22.0, '1.0.0'),
  ('SB-HC-02',  'REC-HC',  'higienizacao', 76, 24.5, 23.0, '1.0.0'),
  ('SB-CC-01',  'REC-CC',  'disponivel',  100, 21.0, 22.0, '1.0.0'),
  ('SB-CC-02',  'REC-CC',  'ocupada',      91, 21.8, 20.5, '1.0.0'),
  ('SB-MZ-01',  'REC-MZ',  'disponivel',   87, 23.2, 22.0, '1.0.0')
) AS v(codigo, loc, status, bateria, temperatura, setpoint, fw)
JOIN locations l ON l.codigo = v.loc
ON CONFLICT (codigo) DO NOTHING;
