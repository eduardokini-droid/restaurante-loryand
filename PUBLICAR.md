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
