# Restaurante Loryand

Carta digital, TPV, PDA de camarero, cocina, barra y caja para restaurantes.
Es una reescritura desde cero que toma como especificación el *Manual de funcionamiento, edición 1.0*.

## Qué cambia respecto a la versión anterior

El manual pedía al personal que vigilara a mano varias cosas. Ahora las garantiza el programa:

| Antes (lo advertía el manual) | Ahora |
|---|---|
| «Repetir una comanda puede duplicar el consumo» | Cada comanda lleva un identificador único. Si se reenvía por una doble pulsación o un corte de conexión, el servidor la reconoce y **no la duplica**. |
| «No vuelvas a cobrar la misma consumición» | Cada cobro lleva su propia clave y la cuenta se bloquea mientras se cobra. Dos dispositivos que cobran a la vez **no pueden cobrar dos veces**, y nunca se cobra más de lo pendiente. |
| «Pendiente de sincronizar no significa recibido por cocina» | Si se va la conexión, la PDA guarda la comanda con su identificador y avisa claramente de que **aún no ha llegado**. Al volver internet se reenvía sola, sin duplicar. |
| Precios que podían alterarse desde el dispositivo | El precio sale siempre de la base de datos, nunca del teléfono. |
| PIN de 4 cifras adivinable | Acceso con límite de intentos fallidos (camareros, panel y clave de mesa). |
| QR personal del camarero que entraba sin PIN (quien lo leyera trabajaba con su identidad) | «Acceso camareros» en el TPV: el camarero pulsa su nombre, escanea un QR de un solo uso que caduca en 2 minutos y entra con **su PIN** (y ficha a la vez). El QR personal impreso también exige el PIN. |
| Mesa pagada confundida con mesa libre | Estado físico separado: Ocupada → Pagada · aún ocupada → Pendiente de limpiar → Libre. No se puede liberar una mesa con cuenta pendiente, y al liberarla se renueva la clave de la carta. |
| Una sola cuenta por mesa «según el uso» | La base de datos impide dos cuentas abiertas en la misma mesa o con el mismo nombre de barra. |
| Borrar un producto cambiaba el historial | Los pedidos guardan nombre y precio del momento de la venta. «Eliminar» archiva el producto. |
| Registro de quién hizo qué | Registro de auditoría: cambios de precio, anulaciones, marchas, uniones de cuentas, cambios de estado de mesa. |

## Funciones incluidas

### Fase 1

- **Gestión**: datos del negocio, carta (categorías, subcategorías, opciones, alérgenos, IVA, destino, pases), mesas con QR y enlace para NFC, etiquetas QR imprimibles, camareros con PIN y QR personal, mesas compartidas o asignación exclusiva, usuarios secundarios con permisos por módulo.
- **PDA del camarero** (en el móvil): fichaje de entrada y salida, plano de mesas, comandas por pases, «Marchar ahora», avisos de clientes, platos listos (Recibido / Entregado), clave de acceso de la mesa, cobro, cola sin conexión.
- **TPV**: mesas y clientes de barra con camarero asociado, más vendidos, cuentas aparcadas.
- **Cocina y barra**: pantallas en tiempo real con cronómetro, colores por retraso y aviso sonoro.
- **Carta del cliente**: por QR/NFC, alérgenos, pedido con clave de mesa, «Mi pedido» con estados, «Llamar al camarero» y «Quiero pagar».
- **Cobro**: efectivo con cambio, tarjeta y Bizum (registro manual), pagos parciales para dividir la cuenta, unir cuentas.
- **Documentos**: proforma (marcada como no justificante de pago) y factura simplificada con numeración correlativa por serie y año y desglose de IVA.
- **Ventas y caja**: periodos (hoy, semana, mes, 45 días), cobrado por forma de pago y por empleado, pendiente aparte, registro documental, impresión del cierre.
- **Gestor general**: alta y desactivación de establecimientos.

### Fase 2
- **Menú del día**: precio por persona, apartados (primero, segundo, postre, bebida, café) con hasta 20 alternativas. Cada persona elige sus platos desde TPV, PDA o carta; el precio se cobra una vez y cada plato va a cocina o barra con su pase.
- **Reservas y turnos**: turnos de comida y cena, duración, margen de cortesía, política de cancelación, fianza por persona a partir de N comensales (no se confirma sin fianza pagada), detección de solapes de mesa y **formulario público** en `/reservar/<local>` que crea solicitudes, no reservas confirmadas.
- **Lista de espera**: propuesta de mesa al grupo más antiguo que quepa con la capacidad más ajustada y respetando su zona; uniones de mesas definidas por el local (suman plazas); mesa protegida al avisar; reservas de las próximas dos horas protegidas; «Ya están sentados», liberar, no presentado.
- **Tiempo estimado de espera** (nuevo): calculado con la duración media real de las mesas del local y su estado (ocupada, pagada, pendiente de limpiar).
- **Factura completa** a partir del ticket con datos fiscales del cliente, dentro del mismo trimestre; el ticket queda sustituido y no duplica importes.
- **Control de camareros**: fichajes, horas, comandas tomadas y cobros realizados por periodo.

### Fase 3
- **Plano del local**: mesas colocadas arrastrándolas (cuadradas, redondas o alargadas) y estado en tiempo real.
- **Almacén**: materias primas y bebidas con stock, mínimo de aviso y coste por unidad; compras (coste medio ponderado), mermas y correcciones de recuento.
- **Escandallos con control de unidades**: conversión automática (ml↔l, g↔kg, envases como «1 botella = 0,75 l») y aviso cuando una cantidad parece un error de unidad (30 l en vez de 30 ml). La venta descuenta del almacén y la anulación lo devuelve.
- **Rentabilidad** por producto: venta sin IVA, coste según escandallo y margen.
- **Fidelización**: fichas de cliente, visitas, gasto, puntos por euro, clientes con más de 45 días sin venir, cupones generales o personales con QR, caducidad, mínimo y número de usos, y **tarjeta digital** del cliente en `/tarjeta/<código>`. El cupón descuenta del total (con el IVA repartido proporcionalmente); no es un cobro.
- **Copias de seguridad**: diaria automática (se guardan 14), manual y preventiva antes de restaurar; descarga en JSON. **Copia externa** opcional en Supabase Storage u otro almacenamiento S3 (31 días + una mensual permanente). **Incluyen la lista de espera y los estados de mesa.** La restauración se verifica antes y se bloquea si hay cuentas abiertas o si se perderían facturas emitidas.
- **Idiomas de la carta**: inglés, francés, alemán, italiano, portugués y ruso, con selector en la carta del cliente (detecta el idioma del teléfono). Traducción manual en la ficha del producto o automática con DeepL si se configura `DEEPL_API_KEY`.

### Fase 4 · Pagos online y WhatsApp
- **Cobro online con Redsys** (tarjeta y Bizum): desde TPV o PDA, «Cobrar con QR» genera un código con el importe fijado; el cliente paga en la pasarela del banco. También «Pagar mi cuenta» desde la carta de la mesa. Solo la notificación firmada del banco confirma el pago.
  - Mientras hay un pago online en curso no se puede cobrar a mano (evita cobrar dos veces).
  - Notificaciones repetidas no duplican; firmas falsas se ignoran.
  - Si el banco cobra pero la cuenta ya no lo admite (p. ej. se cobró en efectivo), el pago queda **«por revisar»** en Sala y en Caja para devolverlo desde Redsys: nunca se pierde un cobro.
  - Entorno de pruebas y real; claves cifradas en la base de datos.
- **Avisos por WhatsApp**: confirmación de reserva, recordatorio (horas antes, una sola vez) y «tu mesa está lista» en la lista de espera.
  - **Modo enlace** (gratis): abre WhatsApp con el mensaje escrito en el móvil del personal.
  - **Modo automático** con la API oficial de WhatsApp Business (plantillas aprobadas por Meta).
  - Registro de avisos enviados, preparados o fallidos.

### Impresión directa en impresoras de tickets
- Impresoras térmicas **ESC/POS** (probado el formato para **Epson TM-T20II**; compatible con la mayoría: Star en modo ESC/POS, Bixolon, marcas blancas). Página de códigos PC858: ñ, tildes y €.
- **Comandas automáticas** por puesto (cocina / barra) al enviar el pedido, con los pases en espera indicados; al «Marchar» se imprime ese pase. Ticket o factura en la impresora de caja (automático al cobrar, opcional).
- **Agente de impresión** (`agent/`): un archivo para un ordenador del local (Windows, Mac, Linux o Raspberry Pi) que recoge los trabajos y los envía por red (puerto 9100), USB en Linux, impresora compartida de Windows o CUPS. Cola con reintentos: si se apaga, los trabajos salen al volver. La impresión nunca impide registrar comandas ni cobros.

## Puesta en marcha

Requisitos: Node.js 22 y PostgreSQL 14 o superior.

```bash
cp .env.example .env        # y edita DATABASE_URL y SESSION_SECRET
npm install
npm run build
npm run seed                # opcional: local de demostración
npm start                   # http://localhost:3000
```

En desarrollo: `npm run dev` (web en http://localhost:5173 con recarga automática).

Datos de demostración (`npm run seed`):

| Acceso | Usuario | Clave |
|---|---|---|
| Gestor general | `gestor` | `gestor1234` |
| Administrador del local | `admin` | `admin1234` |
| Pantalla de cocina / barra | `cocina` / `barra` | `cocina1234` / `barra1234` |
| Camareros (en /personal, local `demo`) | `camarero-1` / `camarero-2` | PIN `1111` / `2222` |

Direcciones: `/gestion` (panel), `/personal` (PDA), `/carta/<código-de-mesa>` (cliente).

## Pruebas

```bash
npm test                    # 78 pruebas de integración contra PostgreSQL (base loryand_test)
node e2e/servicio-completo.cjs /tmp/capturas   # servicio completo en navegador real
node e2e/fase2.cjs /tmp/capturas               # lista de espera, reservas, menú y factura completa
node e2e/fase3.cjs /tmp/capturas               # plano, almacén, cupones, idiomas, copias y tarjeta
node e2e/fase4.cjs /tmp/capturas               # cobro con QR (Redsys simulado) y aviso por WhatsApp
node e2e/impresion.cjs /tmp/capturas           # agente real con impresora de red simulada
node e2e/acceso.cjs /tmp/capturas              # acceso de camareros desde el TPV con QR de un solo uso + PIN
```

Las pruebas cubren: comandas duplicadas, opciones obligatorias, pases retenidos, fichaje, modo exclusivo, cuentas de barra,
bloqueo de cobro con platos sin servir, doble cobro, cobros simultáneos, pagos parciales, numeración de tickets e IVA,
estados físicos de la mesa, clave de la carta, límite de intentos, avisos sin duplicar, PIN únicos, unión de cuentas y cierre de caja.

## Hoja de ruta

**Pendiente**
- **VERI\*FACTU** (al final; obligación prevista el 01/10/2028): registros de facturación con huella encadenada, QR en el ticket y envío a la AEAT. Validar con la asesoría.

> Las funciones fiscales describen el comportamiento del programa: no certifican el cumplimiento normativo ni sustituyen la revisión de la asesoría.
