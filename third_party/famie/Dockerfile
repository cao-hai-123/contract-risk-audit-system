# FAMIE is retained as an independent GPL-3.0 service. See source/famie-main/LICENSE.
FROM python:3.8-slim

WORKDIR /opt/famie

COPY constraints.txt ./constraints.txt
COPY source/famie-main/requirements.txt source/famie-main/setup.py source/famie-main/README.md ./
COPY source/famie-main/src ./src
COPY source/famie-main/app-ui ./app-ui

RUN pip install --no-cache-dir pip==25.0.1 setuptools==75.3.4 wheel==0.45.1
# Trankit 1.1.0 requires torch >=1.6,<1.8; keep its supported CPU runtime.
RUN pip install --no-cache-dir -c constraints.txt torch==1.7.1+cpu --extra-index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir -c constraints.txt -r requirements.txt \
  && pip install --no-cache-dir --no-deps -e . \
  && pip check \
  && useradd --create-home --uid 10001 famie \
  && install -d -o 10001 -g 10001 /home/famie/.famie

COPY patch-trankit-download.py ./patch-trankit-download.py
RUN python patch-trankit-download.py

USER famie
ENV HOME=/home/famie FAMIE_WORKING_DIR=/home/famie/.famie OMP_NUM_THREADS=4 MKL_NUM_THREADS=4 PYTHONUNBUFFERED=1

EXPOSE 9000

CMD ["famie", "start", "--port", "9000", "--selection", "mnlp"]
