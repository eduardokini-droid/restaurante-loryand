#!/bin/sh
# Agente de impresión de Restaurante Loryand (Linux, macOS, Raspberry Pi).
cd "$(dirname "$0")"
while true; do
  node agente.mjs
  echo "El agente se ha detenido. Se reinicia en 5 segundos..."
  sleep 5
done
