# Boot do módulo Siesta Box — apenas inicializa e entrega o controle ao main.py
import gc
import network
import time

try:
    import webrepl

    webrepl.start()
except Exception:
    pass

gc.collect()
time.sleep(0.2)
