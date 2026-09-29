/* ==========================================================================
   Siesta Box Platform — frontend
   Comunicação em tempo real via WebSocket + cópia de firmware.
   ========================================================================== */

const API = window.SIESTA_API_BASE || '';
const WS_URL = (() => {
  if (API) return API.replace(/^http/, 'ws') + '/ws';
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
})();

let units = new Map();
let selected = null;
let ws = null;
let reconnectTimer = null;

const $ = (id) => document.getElementById(id);

/* ── Navegação por abas ───────────────────────────────────────────────── */
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    btn.classList.add('active');
    const target = $(`tab-${btn.dataset.tab}`);
    if (target) target.classList.add('active');
  });
});

/* ── Saúde da API ─────────────────────────────────────────────────────── */
async function checkHealth() {
  const dot = $('apiDot');
  const label = $('apiStatus');
  try {
    const res = await fetch(`${API}/api/health`, { cache: 'no-store' });
    const data = await res.json();
    dot.className = 'dot live';
    label.textContent = `API ok · ${data.dependencias.mqtt ? 'MQTT on' : 'MQTT off'}`;
    $('kpiOnline').textContent = data.unidades_online ?? '—';
  } catch {
    dot.className = 'dot down';
    label.textContent = 'API indisponível';
  }
}

/* ── KPIs ─────────────────────────────────────────────────────────────── */
async function loadDashboard() {
  try {
    const res = await fetch(`${API}/api/dashboard`, { cache: 'no-store' });
    const d = await res.json();
    $('kpiUnits').textContent = d.resumo?.unidades_total ?? '—';
    $('kpiOnline').textContent = d.resumo?.online ?? '—';
    $('kpiLatency').textContent =
      d.latencia_comandos?.media !== null && d.latencia_comandos?.media !== undefined
        ? `${d.latencia_comandos.media} ms`
        : '—';
    $('kpiRevenue').textContent = `R$ ${((d.receita?.centavos ?? 0) / 100).toFixed(2).replace('.', ',')}`;

    const body = $('eventsBody');
    if (Array.isArray(d.eventos_recentes) && d.eventos_recentes.length > 0) {
      body.innerHTML = d.eventos_recentes
        .map(
          (e) => `<tr>
            <td class="num">${new Date(e.criado_em).toLocaleTimeString('pt-BR')}</td>
            <td><code>${e.unit_codigo}</code></td>
            <td>${badgeForEvent(e.evento)}</td>
            <td>${e.origem}</td>
          </tr>`,
        )
        .join('');
    }
  } catch {
    /* dashboard é opcional para o painel funcionar */
  }
}

function badgeForEvent(evento) {
  const cls =
    evento === 'aberta' ? 'warn' : evento === 'fechada' ? 'ok' : evento === 'destravada' ? 'ok' : 'neutral';
  return `<span class="badge ${cls}">${evento}</span>`;
}

/* ── Unidades ─────────────────────────────────────────────────────────── */
async function loadUnits() {
  try {
    const res = await fetch(`${API}/api/units`, { cache: 'no-store' });
    const list = await res.json();
    units = new Map(list.map((u) => [u.codigo, u]));
    renderUnits();
    fillBookingUnits(list);
    if (selected === null && list.length > 0) selectUnit(list[0].codigo);
  } catch {
    $('unitsGrid').innerHTML = '<p class="sub">Não foi possível carregar as unidades. A API está no ar?</p>';
  }
}

function renderUnits() {
  const grid = $('unitsGrid');
  if (units.size === 0) {
    grid.innerHTML = '<p class="sub">Nenhuma unidade cadastrada.</p>';
    return;
  }
  grid.innerHTML = [...units.values()]
    .map((u) => {
      const statusClass =
        u.status === 'disponivel' ? 'ok' : u.status === 'ocupada' ? 'warn' : u.status === 'offline' ? 'err' : 'neutral';
      return `<div class="unit-card ${selected === u.codigo ? 'selected' : ''}" data-code="${u.codigo}">
        <div class="code">${u.codigo} ${u.online ? '<span class="badge ok">online</span>' : '<span class="badge err">offline</span>'}</div>
        <span class="loc">${u.local_nome ?? 'sem local'}</span>
        <span class="badge ${statusClass}">${u.status}</span>
        <div class="metrics">
          <span>🔋 <b>${u.bateria ?? '—'}%</b></span>
          <span>🌡 <b>${u.temperatura ?? '—'}°C</b></span>
          <span>${u.porta_aberta ? '🚪<b>aberta</b>' : '🚪<b>fechada</b>'}</span>
        </div>
      </div>`;
    })
    .join('');

  grid.querySelectorAll('.unit-card').forEach((card) => {
    card.addEventListener('click', () => selectUnit(card.dataset.code));
  });
}

function selectUnit(codigo) {
  selected = codigo;
  const u = units.get(codigo);
  renderUnits();
  if (u === undefined) return;

  $('selCode').textContent = codigo;
  $('selLoc').textContent = `${u.local_nome ?? 'sem local'} · ${u.codigo}`;
  updateDoorPanel(u);
  loadEvents(codigo);
}

function updateDoorPanel(u) {
  const open = u.porta_aberta === true;
  const locked = u.trancada === true;

  $('doorIcon').textContent = open ? '🚪' : '🚪';
  $('doorVal').textContent = open ? 'ABERTA' : 'FECHADA';
  $('doorVal').style.color = open ? 'var(--warn-text)' : 'var(--text-main)';

  $('lockIcon').textContent = locked ? '🔒' : '🔓';
  $('lockVal').textContent = locked ? 'TRAVADA' : 'DESTRAVADA';
  $('lockVal').style.color = locked ? 'var(--ok-text)' : 'var(--warn-text)';
}

async function loadEvents(codigo) {
  try {
    const res = await fetch(`${API}/api/units/${codigo}/events`, { cache: 'no-store' });
    const events = await res.json();
    const body = $('eventsBody');
    if (Array.isArray(events) && events.length > 0) {
      body.innerHTML = events
        .map(
          (e) => `<tr>
            <td class="num">${new Date(e.criado_em).toLocaleTimeString('pt-BR')}</td>
            <td><code>${codigo}</code></td>
            <td>${badgeForEvent(e.evento)}</td>
            <td>${e.origem}</td>
          </tr>`,
        )
        .join('');
    } else {
      body.innerHTML = '<tr><td colspan="4" class="sub">sem eventos ainda</td></tr>';
    }
  } catch {
    /* silencioso: o histórico é complementar */
  }
}

function fillBookingUnits(list) {
  const select = $('bkUnit');
  const disponiveis = list.filter((u) => u.status === 'disponivel');
  select.innerHTML = (disponiveis.length > 0 ? disponiveis : list)
    .map((u) => `<option value="${u.codigo}">${u.codigo} — ${u.local_nome ?? ''}</option>`)
    .join('');
}

/* ── Log de eventos ao vivo ───────────────────────────────────────────── */
function logLine(text, cls = '') {
  const log = $('eventLog');
  const time = new Date().toLocaleTimeString('pt-BR');
  const line = document.createElement('div');
  line.innerHTML = `<span class="t">${time}</span> <span class="${cls}">${text}</span>`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  while (log.childElementCount > 120) log.removeChild(log.firstChild);
}

/* ── WebSocket em tempo real ──────────────────────────────────────────── */
function connectWs() {
  const dot = $('wsDot');
  const label = $('wsStatus');

  try {
    ws = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    dot.className = 'dot live';
    label.textContent = 'Tempo real ativo';
    logLine('WebSocket conectado — aguardando eventos do broker', 'ev-ack');
  };

  ws.onclose = () => {
    dot.className = 'dot down';
    label.textContent = 'Tempo real caiu';
    logLine('WebSocket desconectado — reconectando', 'ev-err');
    scheduleReconnect();
  };

  ws.onerror = () => {
    dot.className = 'dot down';
  };

  ws.onmessage = (event) => {
    let msg = null;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleRealtime(msg);
  };
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWs();
  }, 3000);
}

function handleRealtime(msg) {
  const { type, unit, payload } = msg;

  if (type === 'snapshot') {
    const list = payload.units ?? [];
    list.forEach((u) => {
      const existing = units.get(u.codigo) ?? {};
      units.set(u.codigo, { ...existing, ...u });
    });
    renderUnits();
    if (selected !== null) selectUnitQuiet(selected);
    logLine(`Snapshot recebido: ${list.length} unidade(s)`, 'ev-tele');
    return;
  }

  if (type === 'telemetry') {
    const u = units.get(unit);
    if (u !== undefined) {
      Object.assign(u, {
        temperatura: payload.temperature ?? u.temperatura,
        bateria: payload.battery ?? u.bateria,
        porta_aberta: payload.door_open ?? u.porta_aberta,
        trancada: payload.locked ?? u.trancada,
        online: true,
      });
      renderUnits();
      if (unit === selected) {
        const card = [...$('unitsGrid').querySelectorAll('.unit-card')].find((c) => c.dataset.code === unit);
        if (card) card.classList.add('selected');
        updateDoorPanel(u);
      }
    }
    logLine(
      `${unit} telemetria · ${payload.temperature ?? '—'}°C · bateria ${payload.battery ?? '—'}% · RSSI ${payload.rssi ?? '—'}`,
      'ev-tele',
    );
    return;
  }

  if (type === 'door') {
    const u = units.get(unit);
    if (u !== undefined) {
      const ev = payload.event ?? payload.evento;
      if (ev === 'aberta') u.porta_aberta = true;
      if (ev === 'fechada') u.porta_aberta = false;
      if (ev === 'destravada') u.trancada = false;
      if (ev === 'travada') u.trancada = true;
      renderUnits();
      if (unit === selected) {
        const card = [...$('unitsGrid').querySelectorAll('.unit-card')].find((c) => c.dataset.code === unit);
        if (card) card.classList.add('selected');
        updateDoorPanel(u);
      }
    }
    logLine(`${unit} PORTA → ${(payload.event ?? payload.evento).toUpperCase()} (${payload.origin ?? 'firmware'})`, 'ev-door');
    if (selected !== null) loadEvents(selected);
    loadDashboard();
    return;
  }

  if (type === 'ack') {
    const lat = payload.latency_ms;
    $('ackVal').textContent = lat !== null && lat !== undefined ? `${lat} ms` : 'ok';
    logLine(
      `${unit} ACK de ${payload.action ?? 'comando'} · ${payload.ok === false ? 'FALHA' : 'ok'}${lat !== null && lat !== undefined ? ` · ${lat} ms` : ''}`,
      'ev-ack',
    );
    return;
  }

  if (type === 'command') {
    logLine(`${unit} comando enviado → ${payload.action}`, 'ev-cmd');
    return;
  }

  if (type === 'status') {
    const u = units.get(unit);
    if (u !== undefined) {
      u.online = payload.online !== false;
      renderUnits();
    }
    logLine(`${unit} status: ${payload.online === false ? 'offline' : 'online'}`, payload.online === false ? 'ev-err' : 'ev-ack');
  }
}

function selectUnitQuiet(codigo) {
  const u = units.get(codigo);
  if (u === undefined) return;
  $('selCode').textContent = codigo;
  $('selLoc').textContent = `${u.local_nome ?? 'sem local'} · ${u.codigo}`;
  updateDoorPanel(u);
}

/* ── Comandos de tranca ───────────────────────────────────────────────── */
async function sendDoorCommand(action) {
  if (selected === null) {
    $('cmdFeedback').textContent = 'Selecione uma unidade primeiro.';
    return;
  }
  const buttons = [$('btnUnlock'), $('btnLock'), $('btnPing')];
  buttons.forEach((b) => (b.disabled = true));
  $('cmdFeedback').textContent = `Enviando "${action}" e aguardando confirmação do firmware…`;

  const started = performance.now();
  try {
    const res = await fetch(`${API}/api/units/${selected}/door/${action}`, { method: 'POST' });
    const data = await res.json();
    const elapsed = Math.round(performance.now() - started);

    if (data.confirmed === true) {
      $('cmdFeedback').innerHTML = `<span class="badge ok">confirmado</span> ${selected} · ${action} · ACK em ${data.latency_ms ?? elapsed} ms (ida e volta ${elapsed} ms)`;
    } else {
      $('cmdFeedback').innerHTML = `<span class="badge err">sem confirmação</span> ${data.mensagem ?? 'firmware não respondeu no timeout'}`;
    }
  } catch (error) {
    $('cmdFeedback').innerHTML = `<span class="badge err">erro</span> ${error.message}`;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

/* ── Reserva e acesso ─────────────────────────────────────────────────── */
async function createBooking() {
  const payload = {
    unit_codigo: $('bkUnit').value,
    horas: Number($('bkHours').value),
    cliente_nome: $('bkName').value || null,
    metodo_pagto: 'pix',
  };
  $('bkResult').innerHTML = '<p class="sub">Gerando cobrança…</p>';
  try {
    const res = await fetch(`${API}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (!res.ok) {
      $('bkResult').innerHTML = `<div class="note">Falha: ${data.erro ?? res.status}</div>`;
      return;
    }

    $('acPin').value = data.acesso.pin;
    $('bkResult').innerHTML = `
      <div class="note" style="background:var(--ok-bg);border-color:var(--ok-border);color:var(--ok-text)">
        Reserva confirmada · ${data.valor_formatado} · Pix ${data.pix.status} (simulado)
      </div>
      <div class="table-wrap" style="margin-top:.75rem">
        <table><tbody>
          <tr><td><strong>Unidade</strong></td><td><code>${data.unit_codigo}</code></td></tr>
          <tr><td><strong>Reserva</strong></td><td><code>${data.booking_id.slice(0, 8)}…</code></td></tr>
          <tr><td><strong>TXID Pix</strong></td><td><code>${data.pix.txid}</code></td></tr>
          <tr><td><strong>PIN de acesso</strong></td><td><code style="font-size:1.05rem;letter-spacing:3px">${data.acesso.pin}</code></td></tr>
          <tr><td><strong>QR payload</strong></td><td><code style="font-size:.72rem">${data.acesso.qr_payload}</code></td></tr>
        </tbody></table>
      </div>`;
    loadUnits();
    loadDashboard();
  } catch (error) {
    $('bkResult').innerHTML = `<div class="note">Erro: ${error.message}</div>`;
  }
}

async function validateAccess() {
  const pin = $('acPin').value.trim();
  if (pin.length !== 6) {
    $('acResult').innerHTML = '<div class="note">Informe o PIN de 6 dígitos gerado na reserva.</div>';
    return;
  }
  $('acResult').innerHTML = '<p class="sub">Validando e enviando comando de destrave…</p>';
  try {
    const res = await fetch(`${API}/api/access/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    const data = await res.json();

    if (!res.ok) {
      $('acResult').innerHTML = `<div class="note">${data.erro}</div>`;
      return;
    }

    const confirmed = data.tranca?.confirmed === true;
    $('acResult').innerHTML = `
      <div class="note" style="background:${confirmed ? 'var(--ok-bg)' : 'var(--warn-bg)'};border-color:${confirmed ? 'var(--ok-border)' : 'var(--warn-border)'};color:${confirmed ? 'var(--ok-text)' : 'var(--warn-text)'}">
        ${confirmed ? 'Acesso autorizado — tranca destravada e confirmada pelo firmware' : 'Acesso autorizado, mas o firmware não confirmou no timeout'}
      </div>
      <div class="table-wrap" style="margin-top:.75rem">
        <table><tbody>
          <tr><td><strong>Unidade</strong></td><td><code>${data.unit_codigo}</code></td></tr>
          <tr><td><strong>Latência do ACK</strong></td><td>${data.tranca?.latency_ms ?? '—'} ms</td></tr>
          <tr><td><strong>Comando</strong></td><td><code>${data.tranca?.command_id?.slice(0, 8) ?? '—'}…</code></td></tr>
        </tbody></table>
      </div>`;
    loadUnits();
  } catch (error) {
    $('acResult').innerHTML = `<div class="note">Erro: ${error.message}</div>`;
  }
}

/* ── Firmware: carregar, copiar e baixar ──────────────────────────────── */
async function loadFirmware() {
  const files = [
    { id: 'fwMain', path: '/firmware/main.py' },
    { id: 'fwBoot', path: '/firmware/boot.py' },
    { id: 'fwCfg', path: '/firmware/config.example.json' },
  ];
  for (const file of files) {
    const el = $(file.id);
    if (el === null) continue;
    try {
      const res = await fetch(file.path, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      el.textContent = await res.text();
    } catch {
      el.textContent = `Não foi possível carregar ${file.path}. O arquivo existe no repositório (pasta firmware/).`;
    }
  }
}

function copyText(text, button) {
  const done = () => {
    const original = button.textContent;
    button.textContent = 'Copiado!';
    button.classList.add('done');
    setTimeout(() => {
      button.textContent = original;
      button.classList.remove('done');
    }, 1800);
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand('copy');
    done();
  } catch {
    /* clipboard bloqueado pelo navegador */
  }
  document.body.removeChild(area);
}

document.querySelectorAll('.copy-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const source = $(btn.dataset.copy);
    if (source === null) return;
    copyText(source.textContent, btn);
  });
});

document.querySelectorAll('.dl-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const link = document.createElement('a');
    link.href = btn.dataset.dl;
    link.download = btn.dataset.name ?? 'arquivo.txt';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  });
});

/* ── Boot ─────────────────────────────────────────────────────────────── */
$('btnUnlock').addEventListener('click', () => sendDoorCommand('unlock'));
$('btnLock').addEventListener('click', () => sendDoorCommand('lock'));
$('btnPing').addEventListener('click', () => sendDoorCommand('ping'));
$('btnBook').addEventListener('click', createBooking);
$('btnValidate').addEventListener('click', validateAccess);

connectWs();
loadUnits();
loadDashboard();
checkHealth();
loadFirmware();
setInterval(() => {
  loadDashboard();
  checkHealth();
}, 15000);
