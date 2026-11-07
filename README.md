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
| Mesa pagada confundida con mesa libre | Estado físico separado: Ocupada → Pagada · aún ocupada → Pendiente de limpiar → Libre. No se puede liberar una mesa con cuenta pendiente, y al liberarla se renueva la clave de la carta. |
| Una sola cuenta por mesa «según el uso» | La base de datos impide dos cuentas abiertas en la misma mesa o con el mismo nombre de barra. |
| Borrar un producto cambiaba el historial | Los pedidos guardan nombre y precio del momento de la venta. «Eliminar» archiva el producto. |
| Registro de quién hizo qué | Registro de auditoría: cambios de precio, anulaciones, marchas, uniones de cuentas, cambios de estado de mesa. |

## Funciones incluidas (fase 1)

- **Gestión**: datos del negocio, carta (categorías, subcategorías, opciones, alérgenos, IVA, destino, pases), mesas con QR y enlace para NFC, etiquetas QR imprimibles, camareros con PIN y QR personal, mesas compartidas o asignación exclusiva, usuarios secundarios con permisos por módulo.
- **PDA del camarero** (en el móvil): fichaje de entrada y salida, plano de mesas, comandas por pases, «Marchar ahora», avisos de clientes, platos listos (Recibido / Entregado), clave de acceso de la mesa, cobro, cola sin conexión.
- **TPV**: mesas y clientes de barra con camarero asociado, más vendidos, cuentas aparcadas.
- **Cocina y barra**: pantallas en tiempo real con cronómetro, colores por retraso y aviso sonoro.
- **Carta del cliente**: por QR/NFC, alérgenos, pedido con clave de mesa, «Mi pedido» con estados, «Llamar al camarero» y «Quiero pagar».
- **Cobro**: efectivo con cambio, tarjeta y Bizum (registro manual), pagos parciales para dividir la cuenta, unir cuentas.
- **Documentos**: proforma (marcada como no justificante de pago) y factura simplificada con numeración correlativa por serie y año y desglose de IVA.
- **Ventas y caja**: periodos (hoy, semana, mes, 45 días), cobrado por forma de pago y por empleado, pendiente aparte, registro documental, impresión del cierre.
- **Gestor general**: alta y desactivación de establecimientos.

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
npm test                    # 21 pruebas de integración contra PostgreSQL (base loryand_test)
node e2e/servicio-completo.cjs /tmp/capturas   # servicio completo en navegador real
```

Las pruebas cubren: comandas duplicadas, opciones obligatorias, pases retenidos, fichaje, modo exclusivo, cuentas de barra,
bloqueo de cobro con platos sin servir, doble cobro, cobros simultáneos, pagos parciales, numeración de tickets e IVA,
estados físicos de la mesa, clave de la carta, límite de intentos, avisos sin duplicar, PIN únicos, unión de cuentas y cierre de caja.

## Hoja de ruta

**Fase 2 · Servicio completo**
- Reservas y turnos con formulario público y fianzas (cap. 19).
- Lista de espera con propuesta de mesa, **tiempo estimado de espera** y unión de mesas (cap. 20).
- Plano visual del local con posiciones arrastrables (cap. 10).
- Menú del día (cap. 8).
- Factura completa con datos del cliente y conversión desde ticket (cap. 18).
- Informe de camareros con fichajes (cap. 24).

**Fase 3 · Gestión**
- Almacén, compras y mermas; escandallos con **control de unidades** (ml/l, g/kg) para evitar el error de «30 litros» (cap. 21-22).
- Fidelización y cupones (cap. 23).
- Copias de seguridad automáticas que **sí incluyen** lista de espera y estados de mesa, con verificación previa a restaurar (cap. 25).
- Traducción de la carta a 6 idiomas (cap. 7).

**Fase 4 · Integraciones (requieren contratos y pruebas reales)**
- Pagos online con Redsys (tarjeta y Bizum) desde el QR de la mesa (cap. 17).
- **VERI\*FACTU**: envío de registros de facturación a la AEAT con huella encadenada y QR en el ticket. Hay que validarlo con la asesoría antes de la fecha de obligación.
- Avisos por WhatsApp o SMS para reservas y lista de espera.
- Impresión directa en impresoras de tickets (ESC/POS) sin el diálogo del navegador.

> Las funciones fiscales describen el comportamiento del programa: no certifican el cumplimiento normativo ni sustituyen la revisión de la asesoría.
