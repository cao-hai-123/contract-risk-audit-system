FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv libreoffice-writer fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
COPY backend/seal/requirements.txt /tmp/seal-requirements.txt
RUN python3 -m venv /opt/seal && /opt/seal/bin/pip install --no-cache-dir -r /tmp/seal-requirements.txt
ENV SEAL_PYTHON=/opt/seal/bin/python

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 3001

CMD ["npm", "run", "server"]
