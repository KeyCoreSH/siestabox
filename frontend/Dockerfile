# ── Frontend estático (nginx) — contexto de build = raiz do repositório ──
FROM nginx:1.27-alpine

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/index.html /usr/share/nginx/html/index.html
COPY frontend/proposta.html /usr/share/nginx/html/proposta.html
COPY frontend/assets/ /usr/share/nginx/html/assets/

# Firmware publicado como arquivo estático: o usuário lê, copia e baixa
# direto da página, sem clonar o repositório.
COPY firmware/main.py            /usr/share/nginx/html/firmware/main.py
COPY firmware/boot.py            /usr/share/nginx/html/firmware/boot.py
COPY firmware/config.example.json /usr/share/nginx/html/firmware/config.example.json

EXPOSE 80
HEALTHCHECK --interval=20s --timeout=4s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
