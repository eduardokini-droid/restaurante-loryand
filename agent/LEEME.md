# Agente de impresión · Restaurante Loryand

Programa pequeño que se deja abierto en un ordenador del restaurante. Recoge las comandas y los tickets
del programa y los envía a las impresoras de tickets (Epson TM-T20II y compatibles ESC/POS).
Si se apaga o se corta internet, los trabajos esperan en cola y salen al volver.

## Instalación (Windows)
1. Instala **Node.js** (versión LTS) desde https://nodejs.org
2. Copia esta carpeta `agent` al ordenador (por ejemplo, al Escritorio).
3. En el programa: **Gestión → Impresoras → Nuevo agente**. Copia el token (solo se muestra una vez).
4. Abre `iniciar-agente.bat`. La primera vez pide la dirección del programa y el token.
5. Para que arranque solo al encender el ordenador: pulsa `Windows + R`, escribe `shell:startup`
   y pon ahí un acceso directo a `iniciar-agente.bat`.

## Conectar la impresora
- **Por red (recomendado)**: impresora con cable de red. En Gestión → Impresoras, tipo «Red» y su IP
  (por ejemplo `192.168.1.50`). La IP sale imprimiendo la hoja de estado: apaga la impresora, mantén
  pulsado FEED y enciéndela.
- **USB en Windows**: instala el controlador de Epson (o usa la impresora ya instalada), compártela
  (Propiedades de impresora → Compartir) con un nombre sencillo, p. ej. `TICKETS`, y en Gestión elige
  tipo «Windows» con ese nombre.
- **USB en Linux / Raspberry Pi**: tipo «Dispositivo» con `/dev/usb/lp0`.
- **macOS / CUPS**: tipo «CUPS» con el nombre de la impresora en el sistema.

Pulsa «Imprimir prueba» en Gestión → Impresoras: deben salir bien la ñ, las tildes y el €.
