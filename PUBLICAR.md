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

## 9. Impresoras de tickets (Epson TM-T20II y compatibles)
En **Gestión → Impresoras** (solo el administrador) están los pasos y los archivos del agente:
1. En un ordenador del restaurante, instala Node.js (LTS) y descarga `agente.mjs` e `iniciar-agente.bat`.
2. Pulsa **Nuevo agente**, copia el token y abre `iniciar-agente.bat`: pide la dirección del programa y el token.
3. Añade la impresora:
   - **Por red**: tipo «Red» y su IP (sale en la hoja de estado: apaga la impresora, mantén FEED y enciéndela).
   - **Por USB en Windows**: instala el controlador de Epson, comparte la impresora con un nombre sencillo
     (p. ej. `TICKETS`) y elige tipo «Windows» con ese nombre.
4. Marca qué imprime cada una (cocina, barra, tickets) y pulsa **Imprimir prueba**: deben salir bien la ñ, las tildes y el €.
5. Para que el agente arranque solo: `Windows + R` → `shell:startup` → acceso directo a `iniciar-agente.bat`.

## 10. Copias fuera del servidor (Supabase Storage)
Las copias automáticas se guardan en la base de datos del programa. Para tenerlas también fuera, en Supabase:

1. En https://supabase.com crea un **proyecto nuevo** solo para esto (p. ej. `loryand-copias`), región Europa.
   *No uses la clave principal (service_role) de Studio Loryand: da acceso a toda su base de datos.*
2. **Storage → New bucket** → nombre `copias-restaurante`, **privado** (sin marcar "Public").
3. **Project Settings → Storage → S3 Connection**: copia el **Endpoint** y la **Region**.
   En **S3 Access Keys → New access key**, copia el **Access key ID** y el **Secret access key**
   (el secreto solo se muestra una vez).
4. En Render: servicio **restaurante-loryand** → **Environment** → añade:
   - `BACKUP_S3_ENDPOINT` = el endpoint (termina en `/storage/v1/s3`)
   - `BACKUP_S3_REGION` = la región (p. ej. `eu-west-3`)
   - `BACKUP_S3_BUCKET` = `copias-restaurante`
   - `BACKUP_S3_ACCESS_KEY` y `BACKUP_S3_SECRET_KEY` = las claves del paso 3
5. Guarda (el servicio se reinicia) y en **Gestión → Copias de seguridad** pulsa **Probar conexión**.

Qué se guarda: `diarias/<local>/dia-DD.json.gz` (los últimos 31 días, se sobrescriben),
`mensuales/<local>/AAAA-MM.json.gz` (una por mes, permanentes) y las manuales y preventivas.
Funciona igual con cualquier almacenamiento compatible con S3 (Cloudflare R2, Backblaze…).

## 11. Seguridad del panel: doble verificación y recuperar la contraseña

**Doble verificación del gestor (obligatoria).** La primera vez que entres como gestor después de esta actualización, el panel te pedirá activarla antes de seguir:
1. Instala en el móvil una aplicación de autenticación (Google Authenticator, Microsoft Authenticator o Authy).
2. Escribe tu contraseña, escanea el código QR y escribe el código de 6 cifras.
3. **Guarda los 10 códigos de emergencia** (imprímelos o guárdalos fuera del móvil). Sirven para entrar si pierdes el móvil.

Los administradores y el resto de usuarios pueden activarla si quieren en **Mi cuenta**.

**Recuperar la contraseña.**
- Cualquier usuario: el administrador del local le genera un **enlace de un solo uso** en *Usuarios y permisos → Enlace para nueva contraseña* y se lo manda (por ejemplo, por WhatsApp). El enlace vale 24 horas.
- El administrador del local: el enlace se lo genera el gestor desde su establecimiento (*Entrar → Usuarios y permisos*).
- Si alguien pierde el móvil de la doble verificación: *Usuarios y permisos → Quitar doble verificación*.

**Enlace por correo (opcional).** Para que «¿Has olvidado la contraseña?» envíe el enlace por correo, crea una cuenta en resend.com, verifica tu dominio y añade en Render:

| Variable | Valor |
|---|---|
| `MAIL_RESEND_API_KEY` | la clave de Resend (empieza por `re_`) |
| `MAIL_FROM` | `Loryand <no-responder@tudominio.es>` |

Cada usuario guarda su correo en **Mi cuenta**.

**Último recurso del gestor** (contraseña olvidada **y** móvil perdido, sin códigos de emergencia): en Render añade `GESTOR_RECOVERY` con la fecha de hoy (`AAAA-MM-DD`) y reinicia el servicio. La contraseña del gestor pasa a ser la de `BOOTSTRAP_ADMIN_PASSWORD` y se quita la doble verificación (se pedirá activarla otra vez al entrar). Solo actúa ese día y una vez. **Después, borra la variable.**

## 12. Protección de datos (RGPD)

1. En **Datos del negocio** rellena razón social, NIF, dirección completa y correo. Mientras falte algo, el panel lo avisa.
2. En la tarjeta **Protección de datos** puedes poner un correo específico para los derechos de los clientes, el Registro Mercantil (si es una sociedad) y los plazos de conservación (por defecto: reservas 12 meses, lista de espera 30 días, avisos de WhatsApp 12 meses).
3. Pulsa **Ver textos legales** y revísalos con tu asesor: son modelos orientativos.
4. Imprime el **Cartel informativo** y ponlo junto a la caja: sirve para informar a quien se apunta a la fidelización o a la lista de espera.

Desde ahora, los avisos por WhatsApp solo se envían a quien lo ha aceptado (casilla en la reserva web, o el personal la marca al tomar la reserva o apuntar en la lista de espera tras preguntarle). A los demás se les avisa por teléfono.
