# =============================================================================
#  Siesta Box — Firmware do Módulo (ESP32 / MicroPython)
#  KeyCore Tech Hub · Desafio Coreto "Siesta Box — Fora da Caixa"
#
#  O que este firmware faz
#  -----------------------
#  1. Conecta na rede Wi-Fi e no broker MQTT (TLS opcional).
#  2. PUBLICA telemetria a cada TELEMETRY_INTERVAL_S (temperatura, umidade,
#     bateria, RSSI, estado da porta e da tranca).
#  3. PUBLICA eventos de porta em tempo real quando o sensor magnético muda
#     de estado (aberta / fechada) — sem esperar o próximo ciclo.
#  4. ASSINA o tópico de comando e, ao receber `unlock`, aciona o relé da
#     tranca, reenvia o evento `destravada` e responde `ack` em < 1 s, o que
#     o navegador confirma via WebSocket.
#  5. Usa LWT (Last Will and Testament) para que o broker marque a unidade
#     como offline automaticamente se o módulo cair.
#
#  Hardware de referência
#  ----------------------
#   - ESP32 DevKit v1 (Wi-Fi)
#   - Relé 1 canal no GPIO 26  → solenoide da tranca
#   - Sensor magnético (reed switch) no GPIO 27 (PULL_UP, fecha no GND)
#   - DHT22 no GPIO 4 (opcional — o código degrada para valores simulados)
#   - ADC no GPIO 34 (divisor de tensão da bateria 12 V)
#
#  Gravação
#  --------
#   mpremote connect /dev/ttyUSB0 fs cp firmware/boot.py  :boot.py
#   mpremote connect /dev/ttyUSB0 fs cp firmware/main.py  :main.py
#   mpremote connect /dev/ttyUSB0 fs cp firmware/config.json :config.json
#   mpremote connect /dev/ttyUSB0 reset
# =============================================================================
