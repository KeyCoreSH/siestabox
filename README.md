# Siesta Box Platform

**Backend, frontend e firmware para operação de hotelaria itinerante com acesso remoto confirmado em tempo real.**

Desenvolvido pela **KeyCore Tech Hub** (CNPJ 42.231.277/0001-75) para o Desafio **Coreto · Siesta Box — Fora da Caixa**
(Prefeitura do Recife · SECTI · EMPREL), edital de 10/09/2026.

> "Tecnologia que devolve tempo."

---

## 1. O que é o projeto

A Siesta Box propõe hospedagem temporária em unidades compactas, móveis e modulares, preparadas para ciclos
sucessivos de **transporte, montagem, operação, desmontagem e reinstalação**. Sem recepção física, cada ciclo cria
gargalos operacionais concretos.

Esta plataforma resolve quatro deles, de ponta a ponta:

| Gargalo operacional | Como a plataforma resolve |
| --- | --- |
| Entrega de chave/acesso | Comando `unlock` via MQTT com **ACK do firmware em menos de 1 segundo** |
| Não se sabe se a porta abriu | Firmware **notifica** `aberta`/`fechada`/`destravada`/`travada`; o navegador recebe por **WebSocket**, sem recarregar |
| Cobrança manual por hora | Reserva gera valor, **TXID Pix** e **PIN/QR Code** de uso único com expiração |
| Manutenção reativa | **Telemetria contínua** de bateria, temperatura, umidade, RSSI e uptime |

O resultado: o operador libera o acesso pelo navegador e vê a confirmação física do módulo na mesma tela, no mesmo
instante. Nada de telefonema, nada de chave física, nada de conferência manual.

---

## 2. Estrutura do repositório

```
siestabox/
├── backend/                 API + ponte MQTT (Node.js · TypeScript · Fastify)
│   ├── src/
│   │   ├── server.ts        Rotas REST e WebSocket
│   │   ├── mqtt.ts          Ponte MQTT ⇄ API ⇄ PostgreSQL (com ACK e timeout)
│   │   ├── db.ts            Pool PostgreSQL/PostGIS e migração do schema
│   │   ├── hub.ts           Fan-out de eventos para clientes WebSocket
│   │   └── config.ts        Configuração por variáveis de ambiente
│   ├── db/schema.sql        Schema PostGIS + seed de Recife (idempotente)
│   ├── tools/device-simulator.mjs   Emulador dos módulos ESP32 (MQTT)
│   ├── Dockerfile           Build multi-stage
│   └── package.json
│
├── frontend/                Painel web (estático, servido por nginx)
│   ├── index.html           Painel, reserva, firmware para copiar/baixar
│   ├── assets/styles.css    Tema claro executivo KeyCore
│   ├── assets/app.js        WebSocket, comandos de tranca, clipboard
│   ├── nginx.conf           Proxy /api e /ws + arquivos do firmware
│   └── Dockerfile
│
├── firmware/                Firmware MicroPython do módulo ESP32
│   ├── main.py              Telemetria, eventos de porta, tranca e ACK
│   ├── boot.py              Inicialização
│   ├── config.example.json  Wi-Fi, broker, pinos, calibração
│   └── requirements.txt
│
├── infra/mosquitto/         Broker MQTT (Mosquitto 2.0)
├── docker-compose.yml       Stack completa
├── docker-compose.dev.yml   Override para bancada
└── .env.example
```

---

## 3. Features

### 3.1 Acesso e tranca eletrônica
- Comandos `unlock`, `lock` e `ping` publicados em `siestabox/<unidade>/cmd`.
- **Confirmação obrigatória**: a API aguarda o `ack` do firmware (timeout de 8 s) e devolve `confirmed` + `latency_ms`.
- Timeout e falhas ficam registrados em `commands` com status `timeout` ou `erro` — nenhuma liberação é presumida.
- Re-tranca automática no firmware, configurável (`auto_lock_s`).
- Geração de **PIN de 6 dígitos** e **payload de QR Code** de uso único, com expiração.

### 3.2 Tempo real (o que o navegador vê)
- WebSocket em `/ws` com **snapshot inicial** e depois fluxo contínuo de eventos:
  `telemetry`, `door`, `status`, `command`, `ack`.
- Eventos de porta aparecem no painel **no instante** em que o reed switch muda — sem polling.
- Log operacional ao vivo com marcação de horário, colorido por tipo de evento.
- Indicador de saúde: API, MQTT e WebSocket visíveis no cabeçalho.

### 3.3 Telemetria e manutenção preditiva
- Coleta de temperatura, umidade, bateria, RSSI, uptime, estado da porta e da tranca.
- Série temporal em `telemetry` para análise de degradação.
- Detecção automática de queda: **Last Will and Testament** (LWT) do MQTT marca a unidade offline,
  e a API também expira quem ficou mais de 60 s sem heartbeat.

### 3.4 Reserva e pagamento
- `POST /api/bookings` cria reserva com horas, valor, método e TXID:
  1 h = R$ 35,00 · 2 h = R$ 60,00 · 4 h = R$ 100,00 · 8 h = R$ 180,00.
- Pix **simulado** nesta versão (sem credenciais bancárias para a avaliação) — ver seção 7 para trocar por PSP real.
- `POST /api/access/validate` valida PIN/QR e dispara um destrave **real** por MQTT, devolvendo a latência do ACK.

### 3.5 Operação e dados
- Locais georreferenciados com `GEOGRAPHY(Point, 4326)` e índice **GIST** (PostGIS) — base para busca por proximidade.
- Estados de unidade: `disponivel`, `ocupada`, `higienizacao`, `manutencao`, `offline`.
- Dashboard com KPIs: unidades, disponíveis, ocupadas, online, temperatura média, bateria média,
  latência média/máxima dos comandos e receita acumulada.

### 3.6 Firmware
- MicroPython para ESP32, **tolerante a hardware ausente**: sem DHT22 ou sem ADC, o firmware degrada para leitura
  simulada em vez de travar — permite testar a lógica antes de montar o protótipo.
- Sensores: relé da tranca (GPIO 26), reed switch (GPIO 27), DHT22 (GPIO 4), ADC da bateria (GPIO 34).
- Reconexão automática de Wi-Fi e MQTT; LWT configurado; debounce de 400 ms no sensor de porta.
- **Copiável direto do painel web** (`/firmware/main.py`), além de baixável em um clique.

### 3.7 Simulador de bancada
- `backend/tools/device-simulator.mjs` emula N módulos falando MQTT de verdade:
  telemetria periódica, eventos de porta, LWT e ACK com latência realista (80–320 ms).
- Permite demonstrar o sistema completo — incluindo a confirmação em tempo real no navegador — **sem hardware algum**.

---

## 4. Como rodar

### 4.1 Stack completa com Docker (recomendado)

```bash
git clone https://github.com/KeyCoreSH/siestabox.git
cd siestabox
cp .env.example .env        # ajuste senhas e portas se precisar
docker compose up -d --build

# Serviços que sobem:
#   db       PostgreSQL 16 + PostGIS 3.4   (interno)
#   mqtt     Eclipse Mosquitto 2.0         (host: 1883)
#   api      Fastify + WebSocket           (host: 8080)
#   web      nginx + painel                (host: 8131)
```

Acesse:

- Painel: **http://localhost:8131**
- API: **http://localhost:8080/api/health**

Simular os módulos ESP32 (para ver o painel ganhar vida):

```bash
docker compose --profile sim up -d simulator
```

Verificação rápida:

```bash
curl -s http://localhost:8080/api/health | jq
curl -s -X POST http://localhost:8080/api/units/SB-REC-01/door/unlock | jq
```

### 4.2 Desenvolvimento local da API

```bash
cd backend
npm install

# Suba apenas banco e broker:
cd .. && docker compose up -d db mqtt && cd backend

export DATABASE_URL="postgresql://keycore_admin:senha@localhost:5432/siestabox_db"
export MQTT_URL="mqtt://localhost:1883"

npm run build && npm start     # produção
npm run dev                    # watch mode
npm run sim                    # simulador de firmware
```

### 4.3 Bancada com portas alternativas

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
# Postgres do host continua em 5432; o container usa 55433
```

### 4.4 Firmware no ESP32

```bash
# 1. Grave o MicroPython no chip
pip install esptool mpremote
esptool.py --chip esp32 --port /dev/ttyUSB0 erase_flash
esptool.py --chip esp32 --port /dev/ttyUSB0 write_flash -z 0x1000 ESP32_GENERIC-20240602-v1.23.0.bin

# 2. Instale o cliente MQTT e copie os arquivos
mpremote connect /dev/ttyUSB0 mip install umqtt.simple
mpremote connect /dev/ttyUSB0 fs cp firmware/main.py :main.py
mpremote connect /dev/ttyUSB0 fs cp firmware/boot.py :boot.py
mpremote connect /dev/ttyUSB0 fs cp firmware/config.example.json :config.json

# 3. Edite o config.json: unit_code, Wi-Fi, IP do broker
# 4. Reinicie
mpremote connect /dev/ttyUSB0 reset
```

Monitor serial:

```bash
mpremote connect /dev/ttyUSB0 repl
# ou
picocom -b 115200 /dev/ttyUSB0
```

---

## 5. Hardware de referência

| Componente | GPIO | Observação |
| --- | --- | --- |
| Relé da tranca | 26 | Módulo de relé ativo em nível baixo |
| Sensor magnético (reed) | 27 | Pull-up interno; fecha no GND com a porta fechada |
| DHT22 (temperatura/umidade) | 4 | Opcional — sem ele o firmware usa leitura simulada |
| ADC da bateria | 34 | Divisor de tensão calibrado para 10,5–12,6 V |
| Alimentação | — | 12 V para o solenoide; buck converter 5 V para o ESP32 |

Envelope de energia: um ESP32 publicando telemetria a cada 10 s consome poucos miliampères em média e pode operar
em modo modem-sleep para reduzir consumo em campo.

---

## 6. Contrato técnico

### 6.1 Tópicos MQTT

| Tópico | Direção | Conteúdo |
| --- | --- | --- |
| `siestabox/<unidade>/telemetry` | firmware → API | temperatura, umidade, bateria, RSSI, uptime |
| `siestabox/<unidade>/door` | firmware → API | aberta, fechada, destravada, travada |
| `siestabox/<unidade>/status` | firmware → API | online (retained, com LWT offline) |
| `siestabox/<unidade>/cmd` | API → firmware | unlock, lock, ping, ar_set |
| `siestabox/<unidade>/ack` | firmware → API | command_id, ok, estado atual |

### 6.2 API REST

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/api/health` | Status da API, banco, MQTT e clientes WebSocket |
| GET | `/api/locations` | Locais com coordenadas e unidades disponíveis |
| GET | `/api/units` | Unidades (filtros `location_id`, `status`) |
| GET | `/api/units/:codigo` | Detalhe da unidade |
| POST | `/api/units/:codigo/door/:action` | `unlock` \| `lock` \| `ping` — aguarda ACK |
| GET | `/api/units/:codigo/events` | Últimos 50 eventos de porta |
| GET | `/api/units/:codigo/telemetry` | Últimas 100 leituras |
| POST | `/api/bookings` | Cria reserva + Pix simulado + código de acesso |
| POST | `/api/access/validate` | Valida PIN/QR e destrava o módulo |
| GET | `/api/dashboard` | KPIs, latências, eventos recentes, receita |
| WS | `/ws` | Eventos em tempo real |

### 6.3 Exemplo de fluxo completo

```bash
# 1. Reservar (gera PIN)
RESERVA=$(curl -s -X POST http://localhost:8080/api/bookings \
  -H 'Content-Type: application/json' \
  -d '{"unit_codigo":"SB-REC-01","horas":2,"cliente_nome":"Teste"}')
echo "$RESERVA" | jq
PIN=$(echo "$RESERVA" | jq -r '.acesso.pin')

# 2. Validar o PIN — dispara o destrave real
curl -s -X POST http://localhost:8080/api/access/validate \
  -H 'Content-Type: application/json' \
  -d "{\"pin\":\"$PIN\"}" | jq
# → { "autorizado": true, "tranca": { "confirmed": true, "latency_ms": 148, ... } }

# 3. Acompanhar o fluxo em tempo real
websocat ws://localhost:8080/ws
```

### 6.4 Modelo de dados

| Tabela | Papel |
| --- | --- |
| `locations` | Pontos de operação com `GEOGRAPHY(Point,4326)` e índice GIST |
| `units` | Módulos: status, tranca, porta, bateria, temperatura, heartbeat |
| `bookings` | Reservas com horas, valor, método e TXID Pix |
| `access_codes` | PIN e payload de QR, com expiração e uso único |
| `commands` | Comandos emitidos, status final e latência de confirmação |
| `door_events` | Histórico de abertura, fechamento, destrave e trava |
| `telemetry` | Série temporal de sensores |

O schema é **idempotente** e aplicado automaticamente na inicialização da API (`db/schema.sql`),
com seed dos quatro pontos de Recife e oito unidades de demonstração.

---

## 7. Ir para produção

1. **Pagamento real.** Substitua o Pix simulado em `POST /api/bookings` por um PSP
   (Efí, Mercado Pago, Asaas): crie a cobrança, guarde o `txid` e confirme o pagamento por **webhook**
   antes de liberar o código de acesso. `bookings.pix_txid` é o campo de idempotência.
2. **Autenticação.** Proteja a API e o painel (JWT, mTLS ou reverse proxy autenticado) —
   hoje o painel é aberto, adequado apenas para demonstração.
3. **MQTT seguro.** `allow_anonymous false` + `password_file` no Mosquitto, TLS na porta 8883 e
   credenciais distintas por unidade.
4. **Segredos fora do Git.** Senhas do Postgres e do broker via `.env` (já ignorado) ou gerenciador de segredos.
5. **Observabilidade.** Métricas de latência de ACK já são persistidas; exponha-as em `/metrics` (Prometheus).
6. **Escala MQTT.** Para centenas de módulos, considere cluster de brokers ou serviço MQTT gerenciado.

---

## 8. Testes manuais de verificação

```bash
# API de pé?
curl -s http://localhost:8080/api/health | jq '.status, .dependencias'

# Unidades cadastradas
curl -s http://localhost:8080/api/units | jq '.[].codigo'

# Destrave com confirmação (com o simulador rodando)
curl -s -X POST http://localhost:8080/api/units/SB-REC-01/door/unlock | jq

# Eventos registrados
curl -s http://localhost:8080/api/units/SB-REC-01/events | jq '.[0:5]'

# Dashboard
curl -s http://localhost:8080/api/dashboard | jq '.resumo, .latencia_comandos'
```

---

## 9. Licença e titularidade

Uso interno e submissão ao Desafio Siesta Box — Fora da Caixa.

Atenção ao item 10 do edital: a propriedade intelectual das **propostas submetidas ao desafio** é titularidade da
Siesta Box. Este repositório é o artefato técnico da proposta e deve ser tratado com a confidencialidade
correspondente.

---

**KeyCore Tech Hub** · CNPJ 42.231.277/0001-75
Transformamos gargalos operacionais em tempo, clareza e eficiência.
