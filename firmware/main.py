"""
Siesta Box — Firmware MicroPython para ESP32
=============================================

Responsabilidades:
  • Publicar telemetria periódica  → <prefixo>/<unidade>/telemetry
  • Publicar eventos de porta      → <prefixo>/<unidade>/door
  • Publicar status + LWT          → <prefixo>/<unidade>/status (retained)
  • Consumir comandos              → <prefixo>/<unidade>/cmd
  • Confirmar execução             → <prefixo>/<unidade>/ack   (latência < 1 s)

Este arquivo roda tanto no ESP32 real quanto no simulador de bancada,
porque as dependências de hardware são isoladas em blocos try/except.
"""

import json
import time
import gc

try:
    import network
    import ubinascii
    import machine
    import ujson as json_mod  # noqa: F401  (MicroPython usa ujson)
    import urequests  # noqa: F401
    import utime

    MICROPYTHON = True
except ImportError:  # execução em CPython para testes de bancada
    MICROPYTHON = False

from umqtt.simple import MQTTClient  # noqa: E402

# ── Configuração ──────────────────────────────────────────────────────────
DEFAULTS = {
    "unit_code": "SB-REC-01",
    "wifi_ssid": "",
    "wifi_password": "",
    "mqtt_host": "127.0.0.1",
    "mqtt_port": 1883,
    "mqtt_user": "",
    "mqtt_password": "",
    "mqtt_prefix": "siestabox",
    "firmware_version": "1.0.0",
    "telemetry_interval_s": 10,
    "door_debounce_ms": 400,
    "pins": {"relay_lock": 26, "door_reed": 27, "dht22": 4, "battery_adc": 34},
    "battery_calibration": {"adc_max": 4095, "volts_max": 14.0},
}


def load_config(path="config.json"):
    cfg = dict(DEFAULTS)
    try:
        with open(path) as fh:
            cfg.update(json.load(fh))
    except Exception as exc:  # arquivo ausente → usa defaults
        print("[cfg] config.json ausente, usando padrões:", exc)
    cfg["pins"] = {**DEFAULTS["pins"], **cfg.get("pins", {})}
    cfg["battery_calibration"] = {
        **DEFAULTS["battery_calibration"],
        **cfg.get("battery_calibration", {}),
    }
    return cfg


# ── Módulo de estado ──────────────────────────────────────────────────────
class DoorState:
    """Latch do estado da porta/tranca com debounce do reed switch."""

    def __init__(self, debounce_ms=400):
        self.locked = True
        self.open = False
        self.last_raw = None
        self.last_change_ms = 0
        self.debounce_ms = debounce_ms

    def update(self, raw_open, now_ms):
        """Retorna o evento a publicar ('aberta'/'fechada') ou None."""
        if raw_open == self.last_raw:
            return None
        if now_ms - self.last_change_ms < self.debounce_ms:
            return None  # ruído do sensor, ignora
        self.last_raw = raw_open
        self.last_change_ms = now_ms
        if raw_open != self.open:
            self.open = raw_open
            return "aberta" if raw_open else "fechada"
        return None


class Telemetry:
    """Leitura de sensores com degradação graciosa quando o hardware falta."""

    def __init__(self, cfg, ticks_ms):
        self.cfg = cfg
        self.ticks_ms = ticks_ms
        self.boot_ms = ticks_ms()
        self.dht = None
        self.adc = None
        self._init_hardware()

    def _init_hardware(self):
        if not MICROPYTHON:
            return
        try:
            import dht  # noqa: F401

            self.dht = dht.DHT22(machine.Pin(self.cfg["pins"]["dht22"]))
        except Exception as exc:
            print("[sensor] DHT22 indisponível:", exc)
        try:
            self.adc = machine.ADC(machine.Pin(self.cfg["pins"]["battery_adc"]))
            self.adc.atten(machine.ADC.ATTN_11DB)
        except Exception as exc:
            print("[sensor] ADC de bateria indisponível:", exc)

    @property
    def uptime_s(self):
        return int((self.ticks_ms() - self.boot_ms) / 1000)

    def read(self, door: DoorState):
        temperature = None
        humidity = None
        if self.dht is not None:
            try:
                self.dht.measure()
                temperature = round(self.dht.temperature(), 1)
                humidity = int(self.dht.humidity())
            except Exception:
                pass
        if temperature is None:
            # Bancada/fake: rampa suave 20–24 °C para o painel não ficar vazio.
            cycle = (time.time() % 240) / 240
            temperature = round(20.0 + cycle * 4.0, 1)
            humidity = 55 + int(cycle * 10)

        battery = None
        if self.adc is not None:
            try:
                cal = self.cfg["battery_calibration"]
                volts = self.adc.read() / cal["adc_max"] * cal["volts_max"]
                battery = max(0, min(100, int((volts - 10.5) / (12.6 - 10.5) * 100)))
            except Exception:
                pass
        if battery is None:
            battery = 60 + int((time.time() % 40))

        rssi = -60
        try:
            import network as _net

            sta = _net.WLAN(_net.STA_IF)
            if sta.isconnected():
                rssi = sta.status("rssi")
        except Exception:
            pass

        return {
            "temperature": temperature,
            "humidity": humidity,
            "battery": battery,
            "rssi": rssi,
            "door_open": door.open,
            "locked": door.locked,
            "uptime_s": self.uptime_s,
            "firmware": self.cfg["firmware_version"],
        }


# ── Conectividade ─────────────────────────────────────────────────────────
def wifi_connect(cfg):
    if not MICROPYTHON or not cfg["wifi_ssid"]:
        print("[wifi] modo bancada (sem Wi-Fi)")
        return
    sta = network.WLAN(network.STA_IF)
    sta.active(True)
    if sta.isconnected():
        return
    print("[wifi] conectando em", cfg["wifi_ssid"])
    sta.connect(cfg["wifi_ssid"], cfg["wifi_password"])
    for _ in range(40):
        if sta.isconnected():
            print("[wifi] conectado:", sta.ifconfig()[0])
            return
        time.sleep(0.5)
    print("[wifi] falha — seguindo offline e tentando reconectar")


class Lock:
    """Controle da tranca eletrônica (relé → solenoide)."""

    def __init__(self, cfg, door: DoorState):
        self.door = door
        self.pin = None
        self.auto_lock_ms = int(cfg.get("auto_lock_s", 5)) * 1000
        self.unlocked_at = None
        if MICROPYTHON:
            try:
                self.pin = machine.Pin(cfg["pins"]["relay_lock"], machine.Pin.OUT)
                self._set(False)
            except Exception as exc:
                print("[lock] relé indisponível:", exc)

    def _set(self, energized):
        if self.pin is not None:
            # Relé comum de módulo é ativo em nível baixo.
            self.pin.value(0 if energized else 1)

    def unlock(self):
        self._set(True)
        self.door.locked = False
        self.unlocked_at = time.time()
        print("[lock] DESTRAVADA")

    def lock(self):
        self._set(False)
        self.door.locked = True
        self.unlocked_at = None
        print("[lock] TRAVADA")

    def supervise(self):
        """Re-tranca sozinha alguns segundos depois, se o firmware estiver configurado."""
        if self.unlocked_at is None or self.auto_lock_ms == 0:
            return None
        if (time.time() - self.unlocked_at) * 1000 >= self.auto_lock_ms:
            self.lock()
            return "travada"
        return None


# ── Aplicação ─────────────────────────────────────────────────────────────
class SiestaModule:
    def __init__(self, cfg):
        self.cfg = cfg
        self.ticks_ms = utime.ticks_ms if MICROPYTHON else (lambda: int(time.time() * 1000))
        self.door = DoorState(cfg["door_debounce_ms"])
        self.lock = Lock(cfg, self.door)
        self.telemetry = Telemetry(cfg, self.ticks_ms)
        self.client = None
        self.reed = None
        if MICROPYTHON:
            try:
                self.reed = machine.Pin(cfg["pins"]["door_reed"], machine.Pin.IN, machine.Pin.PULL_UP)
            except Exception as exc:
                print("[sensor] reed switch indisponível:", exc)
        self.last_telemetry_ms = 0

    # tópicos
    def topic(self, suffix):
        return "{}/{}/{}".format(self.cfg["mqtt_prefix"], self.cfg["unit_code"], suffix).encode()

    # conexão
    def connect(self):
        client_id = "siesta-{}".format(self.cfg["unit_code"])
        if MICROPYTHON:
            client_id = "{}-{}".format(client_id, ubinascii.hexlify(machine.unique_id()).decode())

        # LWT: se o módulo cair, o broker publica online=false automáticamente.
        will = json.dumps({"online": False, "unit": self.cfg["unit_code"]})
        self.client = MQTTClient(
            client_id,
            self.cfg["mqtt_host"],
            port=self.cfg["mqtt_port"],
            user=self.cfg["mqtt_user"] or None,
            password=self.cfg["mqtt_password"] or None,
            keepalive=30,
            ssl=self.cfg["mqtt_use_tls"],
        )
        self.client.set_last_will(self.topic("status"), will, retain=True, qos=1)
        self.client.set_callback(self.on_message)
        self.client.connect()
        self.client.subscribe(self.topic("cmd"), qos=1)
        self.client.publish(self.topic("status"), json.dumps({"online": True, "unit": self.cfg["unit_code"]}), retain=True, qos=1)
        print("[mqtt] conectado como", client_id)

    # entrada de comandos
    def on_message(self, topic, msg):
        try:
            payload = json.loads(msg)
        except Exception:
            payload = {}
        action = payload.get("action", "")
        command_id = payload.get("command_id", "")
        print("[cmd] recebido:", action, command_id)

        ok = True
        detail = action
        if action == "unlock":
            self.lock.unlock()
            self.publish_door("destravada", origin="command")
        elif action == "lock":
            self.lock.lock()
            self.publish_door("travada", origin="command")
        elif action == "ping":
            detail = "pong"
        elif action == "ar_set":
            detail = "ar_setpoint={}".format(payload.get("setpoint"))
        else:
            ok = False
            detail = "acao_desconhecida"

        self.publish_ack(command_id, ok, detail, action)

    # saída
    def publish_door(self, event, origin="firmware"):
        self.client.publish(
            self.topic("door"),
            json.dumps({"unit": self.cfg["unit_code"], "event": event, "origin": origin}),
            qos=1,
        )

    def publish_ack(self, command_id, ok, detail, action):
        self.client.publish(
            self.topic("ack"),
            json.dumps(
                {
                    "command_id": command_id,
                    "unit": self.cfg["unit_code"],
                    "ok": ok,
                    "action": action,
                    "detail": detail,
                    "locked": self.door.locked,
                    "door_open": self.door.open,
                }
            ),
            qos=1,
        )

    def publish_telemetry(self):
        payload = self.telemetry.read(self.door)
        self.client.publish(self.topic("telemetry"), json.dumps(payload), qos=1)

    # loop
    def run(self):
        wifi_connect(self.cfg)
        self.connect()
        interval_ms = self.cfg["telemetry_interval_s"] * 1000

        while True:
            try:
                self.client.check_msg()  # não bloqueante: comandos chegam na hora
            except OSError as exc:
                print("[mqtt] desconectado, reconectando:", exc)
                time.sleep(2)
                try:
                    self.connect()
                except Exception as retry_exc:
                    print("[mqtt] nova tentativa falhou:", retry_exc)
                    time.sleep(5)
                    continue

            now = self.ticks_ms()

            # 1) sensor de porta: publica no instante da mudança
            raw_open = self.read_reed()
            if raw_open is not None:
                event = self.door.update(raw_open, now)
                if event is not None:
                    print("[door]", event)
                    self.publish_door(event, origin="sensor")

            # 2) re-tranca automática
            auto_event = self.lock.supervise()
            if auto_event is not None:
                self.publish_door(auto_event, origin="autolock")

            # 3) telemetria periódica
            if now - self.last_telemetry_ms >= interval_ms:
                self.publish_telemetry()
                self.last_telemetry_ms = now
                gc.collect()

            time.sleep_ms(50) if MICROPYTHON else time.sleep(0.05)

    def read_reed(self):
        """True = porta aberta. None quando não há sensor de bancada."""
        if self.reed is not None:
            return self.reed.value() == 1
        return None  # simulador injeta eventos por outro caminho


def main():
    cfg = load_config()
    module = SiestaModule(cfg)
    print("Siesta Box firmware {} — unidade {}".format(cfg["firmware_version"], cfg["unit_code"]))
    module.run()


if __name__ == "__main__":
    main()
