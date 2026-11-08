# Publicar Restaurante Loryand en Render

Render instala el programa directamente desde GitHub y lo actualiza solo cada vez que se sube un cambio.
Incluye el servidor siempre encendido (necesario para que cocina, barra y PDA se actualicen al instante)
y la base de datos PostgreSQL.

## 1. Crear la cuenta
Entra en https://render.com y pulsa **Get Started** → **GitHub**. Así Render ya puede ver tus repositorios.

## 2. Desplegar con un clic
Abre este enlace:

https://render.com/deploy?repo=https://github.com/eduardokini-droid/restaurante-loryand

Render lee el archivo `render.yaml` y te propone crear:
- **restaurante-loryand**: el servidor web (plan Starter).
- **loryand-db**: la base de datos PostgreSQL (plan Basic 256 MB).

Te pedirá un valor:
- **BOOTSTRAP_ADMIN_PASSWORD**: la contraseña del gestor general. Mínimo 12 caracteres. Guárdala bien.

Pulsa **Apply** / **Deploy Blueprint**. La primera vez tarda unos 5 minutos.
Render pedirá una tarjeta: los planes de pago se cobran por uso (consulta el precio actual en la propia página de Render).

## 3. Entrar
Cuando el servicio esté en verde (**Live**), Render muestra su dirección, del estilo
`https://restaurante-loryand.onrender.com`.

| Dónde | Usuario | Contraseña / PIN |
|---|---|---|
| `/gestion` · gestor general | `gestor` | la que pusiste en BOOTSTRAP_ADMIN_PASSWORD |
| `/gestion` · administrador de Casa Demo | `admin` | la misma |
| `/gestion` · pantallas de cocina y barra | `cocina`, `barra` | la misma |
| `/personal` · camareros (local `demo`) | `camarero-1`, `camarero-2` | PIN `1111`, `2222` |
| `/reservar/demo` | formulario público de reservas | — |

Las cartas de cada mesa están en **Gestión → Mesas y QR** (enlace y etiquetas QR).

## 4. Tu dominio (opcional)
Para usar, por ejemplo, `nuevo.loryand.es` sin tocar la versión actual de `restaurante.loryand.es`:
1. En Render: servicio **restaurante-loryand** → **Settings** → **Custom Domains** → **Add** → `nuevo.loryand.es`.
2. En IONOS: **Dominios** → `loryand.es` → **DNS** → añadir registro **CNAME**:
   nombre `nuevo`, destino el que indica Render (`restaurante-loryand.onrender.com`).
3. Render activa el certificado HTTPS solo, en unos minutos.

Cuando quieras sustituir la versión antigua, se hace lo mismo con `restaurante`.

## 5. Después de probar
- Para que no se cree más el local de demostración: **Environment** → `SEED_DEMO` = `false`.
  (Lo ya creado no se borra; puedes desactivarlo desde el panel del gestor.)
- Cada cambio que se suba a GitHub (rama `main`) se publica solo.
- Copias de seguridad: Render guarda copias diarias de la base de datos en los planes de pago
  (**loryand-db** → **Recovery**). La fase 3 añade además copias propias del programa.

## 6. Traducción automática de la carta (opcional)
Las traducciones se pueden escribir a mano en la ficha de cada producto. Para el botón
«Traducir automáticamente desde el español» hace falta una clave de DeepL (https://www.deepl.com/pro-api,
hay plan gratuito):
1. En Render: servicio **restaurante-loryand** → **Environment** → **Add Environment Variable**.
2. Nombre `DEEPL_API_KEY`, valor tu clave. Guarda: el servicio se reinicia solo.

## 7. Pagos online con Redsys (tarjeta y Bizum)
Se configura en **Gestión → Pagos y WhatsApp** (solo el administrador).

**Probar primero en el entorno de pruebas (gratis, no cobra):**
1. Pulsa «Rellenar con los datos públicos de pruebas de Redsys», marca Tarjeta (y Bizum si quieres),
   marca «Habilitar cobro online» y guarda.
2. Haz una comanda en una mesa, pulsa **Cobrar con QR · Tarjeta / Bizum** y escanea el QR con el móvil.
3. En la pasarela de pruebas de Redsys usa la tarjeta de pruebas que indica su documentación
   (habitualmente 4548 8100 0000 0003, caducidad futura, CVV 123). Si no funciona, el banco te facilita las suyas.
4. A los pocos segundos la PDA debe mostrar **Pagado** y la cuenta queda cobrada con su ticket.

**Pasar a real:** pide al banco el TPV virtual (y Bizum si lo quieres). Introduce tu código de comercio,
terminal y clave de firma SHA-256 (están en el panel de Redsys), elige «Real» y guarda.
La «URL de notificación» que aparece en esa pantalla es la que usa Redsys para confirmar cada pago;
normalmente no hay que configurarla en Redsys porque el programa la envía en cada operación.
Las devoluciones se hacen desde el panel de Redsys.

## 8. Avisos por WhatsApp
En **Gestión → Pagos y WhatsApp**:
- **Modo enlace** (gratis, sin alta): activa los avisos y guarda. Al confirmar una reserva o avisar a un
  grupo de la lista de espera, aparece «Abrir WhatsApp» con el mensaje escrito; solo hay que pulsar enviar.
- **Envío automático**: necesitas WhatsApp Business Platform (Meta Business, número verificado y
  plantillas aprobadas). Copia el identificador del número y un token de acceso permanente, crea las tres
  plantillas con las variables indicadas en la pantalla y prueba con «Enviar prueba» a tu móvil.
  En este modo también se envían recordatorios automáticos antes de cada reserva confirmada.
