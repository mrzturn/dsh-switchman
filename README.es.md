# dsh-switchman

[English](./README.md) | [简体中文](./README.zh.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | **Español** | [Français](./README.fr.md) | [Deutsch](./README.de.md) | [Italiano](./README.it.md) | [Português](./README.pt.md) | [Русский](./README.ru.md)

> **La familia switchman**, mismo autor, misma filosofía de despacho: [opencode-switchman](https://github.com/mrzturn/opencode-switchman) (el original para OpenCode) · [zcode-switchman](https://github.com/mrzturn/zcode-switchman) (el port para ZCode) · **dsh-switchman** (este repositorio, la versión para DeepSeek Harness).

![dsh-switchman — el nivel de agua del contexto maneja la palanca del guardagujas y cada tarea toma su carril](docs/assets/hero.svg)

> Contexto con medidor. Cada tarea encuentra su carril.

## Por qué lo necesitas

Trabajando con DSH, tarde o temprano te topas con dos cosas:

1. **La sesión pesa cada vez más.** El historial hincha el contexto hasta cientos de miles de tokens: el modelo empieza a olvidar, a ir lento y a encarecerse, y al final solo queda el /compact manual, que encima pierde detalles en cada compresión.
2. **El modelo principal lo hace todo él solo.** Leer un archivo, lanzar un test, cotejar datos: todo lo mastica él — lento y caro, siendo la mayor parte un trabajo que correspondería a un modelo barato.

dsh-switchman es un plugin para [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Una vez instalado, el modelo principal deja de «hacerlo todo él solo» y pasa a ser el guardagujas: medir el nivel de agua, elegir el carril, repartir tareas y aceptar el trabajo. No es un modelo nuevo: es un reglamento de despacho enganchado a DSH, más una página de configuración. En concreto hace seis cosas:

**1. Nivel de agua del contexto: la sesión larga no se desborda.** Cada turno contabiliza los tokens de la sesión en vivo, y tres líneas de nivel aprietan por etapas: 50k (soft, ajustable) avisa «toca delegar»; 90k (hard) recorta el presupuesto de lectura de archivos por llamada y empuja al cierre; 130k (force) lanza la entrega automática — bifurca una copia de la sesión como respaldo, compacta el contexto y despierta la continuación, sin que el trabajo se corte. Los subagentes en segundo plano que sigan corriendo en el momento de la entrega tampoco se pierden: id, descripción de la tarea y ruta del informe quedan escritos en el documento de entrega, y la sesión que continúa sabe dónde recoger los informes en vez de volver a despachar el trabajo. Cada subagente despachado lleva su propio techo duro independiente: al alcanzarlo, termina con un resumen HANDOFF.

**2. Seis pools de despacho: a cada trabajo, su modelo.** Pool ligero (economy, tareas pequeñas en lote), mecánico (mechanical, reescrituras con plantilla), principal (main, código del día a día), de alta dificultad (hard, razonamiento difícil y refactorizaciones a gran escala), multimodal (vision, leer imágenes) y de revisión (review, verificación independiente). En la página de ajustes marcas candidatos, ordenas prioridades (con anclaje opcional a las categorías S/A/B/C) y fijas un effort de razonamiento por ruta — el desplegable de categorías sale de los niveles que ese modelo soporta de verdad, no de tres genéricos. Cada turno, el prompt del modelo principal lleva consigo una tabla de recomendaciones `[SWITCHMAN:POOLS]`, y el trabajo se despacha siguiéndola. El modo de ejecución tiene tres estados: off / advice / enforce (enforce = los modelos fuera del pool se rechazan sin más).

**3. Modo Agent Teams: de ir por libre a llevar un equipo.** Desactivado por defecto: recién instalado solo hay despacho ligero por subagent. En la página de ajustes hay dos interruptores independientes:

- **Modo de equipo de agentes** — al activarlo se inyecta el reglamento de equipo (delegación por defecto + verificación por niveles + disciplina del tablero de tareas compartido) y se habilitan automáticamente los Agent Teams de DSH: el modelo principal puede reclutar compañeros residentes (`spawn_teammate`), asignarles trabajo en el tablero compartido (`team_task_*`) e intercambiar mensajes con ellos (`send_message`). Hay una disciplina clara sobre cuándo formar equipo: subtareas independientes que puedan ir en paralelo, trabajo abundante y autocontenido, nivel de agua del contexto principal ya alto o necesidad de separar roles; una investigación puntual de un solo uso sigue yendo por subagent. La política de fábrica de DSH es «no crees equipo si el usuario no lo pide»; aquí se invierte a «úsalo cuando toque». Si vuelves a apagar el interruptor, de las cláusulas de equipo no queda rastro, y las herramientas de equipo no se retiran de las sesiones en marcha.
- **Sincronizar la lista blanca de modelos de subagentes** — DSH tiene una lista blanca de autorización «permitir que los agentes elijan modelos para subagentes»: una ruta elegida en un pool pero no autorizada hace que el despacho explícito del modelo principal sea rechazado (en modo equipo, la tabla de recomendaciones y la página de ajustes marcan esas rutas con ⚠). Al encender este interruptor, la unión de los seis pools se escribe entera en esa lista blanca — sin configurar dos veces: switchman es la única fuente de verdad, y la vía de despacho por fork también queda cubierta. La lista blanca entra en vigor según la instantánea de «nueva sesión»: la sincronización solo afecta a las sesiones abiertas a partir de entonces.

La cabecera de la sesión da un feedback visual claro: la insignia ⚡ «equipo autónomo» y ◇ con el modelo real de la sesión actual; mientras hay una entrega automática en marcha, aparece un aviso en vivo: «entrega en curso · sesión de respaldo / compactación del contexto / continuación despertada».

**4. Preferencias de idioma: pregunta una vez, lo recuerda para siempre.** Un desplegable para cada una de las tres: respuestas, comentarios de código y documentos; el ámbito puede ser global o por proyecto (`.switchman/lang.json`). No hace falta configurarlo: la primera vez que se necesite pregunta una sola vez, en el idioma de la interfaz de tu DSH, y una vez recordado, cada sesión lo respeta automáticamente.

**5. Verificación por niveles: cambiado, comprobado.** Los cambios de más de 20 líneas pasan a verificación de un tester; los de más de 300 líneas, o que toquen lógica central / de seguridad / de consistencia de datos, pasan además a una revisión independiente de un reviewer. El modelo del reviewer se elige anclado al modelo del agente que escribió ese diff, esquivándolo cuando se puede; si en el pool no hay forma de esquivarlo, en la conclusión se declara DOWNGRADED. Dices «no uses equipos» y al instante vuelve al trabajo en solitario.

**6. `/vision`: hasta un modelo de solo texto puede con las imágenes.** Cuando el modelo principal no sabe leer imágenes, DSH rechaza en la puerta de entrada los mensajes con imágenes. Adjunta la imagen y escribe `/vision ¿qué está mal en esta imagen?` — la imagen se resuelve a una ruta de archivo y se entrega a un modelo del pool multimodal para leerla, y la conclusión vuelve a la sesión actual. Sobre el cuadro de entrada aparece por adelantado el aviso «el modelo actual no sabe leer imágenes»; si un envío directo de imagen es rechazado, se reescribe una vez de forma automática a `/vision` y se reenvía, sin rehacer nada a mano; con el pool multimodal sin configurar, el comando se niega y da indicaciones de configuración.

¿Solo tienes un modelo? Sigue mereciendo la instalación — el control del nivel de agua y la verificación por niveles no dependen de cuántos modelos tengas, y una sesión larga con un solo modelo se beneficia igual.

## Skills incluidas

- **db-query** — verificación de MySQL / Redis en solo lectura: ejecuta SQL para cotejar datos, consulta claves de caché / TTL y la consistencia entre almacenes; rechaza cualquier escritura. Requiere inicialización en el primer uso (ver abajo).
- **git-commit-message** — genera el texto de commit conforme a la convención; solo texto, nunca hace git por ti.
- **requirement-docs** — una especificación unificada para análisis de requisitos / PRD / documentos de diseño; los entregables se archivan en `docs/requirements-and-design/`.

## Inicio rápido

1. **Instalar** — pide a un agent que lo ejecute en cualquier sesión, o ve a la página web de gestión de plugins:

   ```
   plugin_manager: install_bundle  target=dsh-switchman
   ```

   o instálalo desde un checkout local (en modo link; tras actualizar toca reinstalar con `remove_bundle` + `install_bundle`):

   ```
   plugin_manager: install_bundle  target=/path/to/dsh-switchman
   ```

   o instálalo desde una terminal con el comando `dsh` — elige el perfil según cómo ejecutes DSH:

   ```bash
   dsh plugin --profile web add dsh-switchman      # Web GUI
   dsh plugin --profile desktop add dsh-switchman   # app de escritorio
   ```

2. **Reiniciar DSH** — cierra la app por completo y vuelve a abrirla (recargar la página no cuenta) — solo así la tabla de módulos del cliente reconocerá el bundle.

3. **Preferencias de idioma** — Ajustes → dsh-switchman, o «Central de despacho Switchman» en la barra lateral de la página de inicio. En la primera pantalla se elige primero el ámbito: global (este profile) o por proyecto (el `.switchman/lang.json` de cada proyecto); después, tres desplegables fijan el idioma de respuestas / comentarios / documentos, cada uno con su línea de estado «actual: …». Puedes saltarlo: en el primer uso se pregunta una vez y se recuerda (se pregunta en el idioma de la interfaz de DSH).

   ![Preferencias de idioma: ámbito y tres idiomas](docs/assets/conf-language.png)

4. **Configurar los pools de despacho** — en cada tarjeta de pool marcas los modelos candidatos agrupados por proveedor; marca «orden manual» y la tarjeta se convierte en una lista de prioridades numerada que se reordena con ↑ ↓ ×, y junto a cada ruta puedes fijar el effort de razonamiento (por defecto «seguir el carril»; al fijarlo, el desplegable lista los niveles que ese modelo soporta de verdad). La línea de resumen superior refleja el progreso en vivo, por ejemplo: «pools configurados: 6/6 · posiciones en el ranking: 2 · modo advice».

   ![Pools de despacho: cuatro pools — ligero / mecánico / principal / de alta dificultad](docs/assets/conf-pool-1.png)

   El pool multimodal y el de revisión están más abajo; después vienen el **orden por capacidad** (la unión de los modelos elegidos en los seis pools, donde el número es el puesto por capacidad, el más fuerte primero, con anclaje opcional a las categorías S/A/B/C) y el **modo de ejecución** (advice / enforce).

   ![Pool multimodal, pool de revisión, orden por capacidad y modo de ejecución](docs/assets/conf-pool-2.png)

5. **Equipo de agentes** — ambos interruptores vienen apagados: arranca primero en modo subagent puro. Si quieres que reclute al equipo por su cuenta, enciende «modo de equipo de agentes»; si quieres ahorrarte la autorización duplicada en dos sitios, enciende «sincronizar la lista blanca de modelos de subagentes»: bajo el interruptor hay una línea de estado «N entradas sincronizadas + fecha» que confirma el resultado de la escritura.

   ![Equipo de agentes: dos interruptores y estado de sincronización de la lista blanca](docs/assets/conf-team.png)

6. **Nivel de agua del contexto** — tres umbrales (por defecto 50000 / 90000 / 130000), presupuesto de lectura por llamada, comportamiento del umbral duro (dejar pasar limitando / bloquear), interruptor de entrega automática y tope independiente para subagentes: todo en esta zona. Abajo, una línea de comandos: `/ctx-pause` pausa la intervención · `/ctx-resume` la reanuda · `/ctx-handover` respalda y entrega ahora mismo (conduce la sesión a la frontera de inactividad y espera la ventana de reintento de compactación; el resultado puede tardar unos minutos).

   ![Nivel de agua del contexto: umbrales, presupuesto y comandos](docs/assets/conf-ctx.png)

7. **Verificar** — en la cabecera de la sesión aparece la insignia ⚡ «equipo autónomo» (al lado, ◇ muestra el modelo de la sesión actual); o pregúntale directamente al modelo «¿cómo se titula la última sección de tu system prompt?» — debería mencionar el reglamento de dsh-switchman.

**Inicialización de db-query en el primer uso** (las dependencias del script se instalan dentro del directorio del skill y no ensucian el proyecto):

```bash
bash <install-dir>/skills/db-query/scripts/setup.sh
```

## Cómo funciona

- La mitad Host (`index.js` + `host/`) inyecta las secciones dinámicas del system prompt (idioma / carriles / nivel de agua / equipo), la doble compuerta de presupuesto de lectura y enforce, y cuatro comandos slash (el trío ctx + `/vision`). Todos los ajustes, una vez guardados, surten efecto en el siguiente ensamblado del prompt, sin reinicio.
- La mitad Client (`client.js`) pinta la página de ajustes, la insignia ⚡ y la marca de modelo ◇ en la cabecera de la sesión y el aviso dinámico de entrega en curso, apoyándose en los servicios oficiales settings-form.
- La entrada «Central de despacho Switchman» en la barra lateral de la página de inicio: un clic abre esta misma página de configuración (preferencias de idioma, pools y ranking, nivel de agua) como panel central; la entrada de ajustes original se conserva.
- `cordis.patch.yml` conserva íntegra la lista de plugins de los presets de fábrica y solo amplía el persona suffix; las herramientas de Agent Teams en sí vienen del bundle de fábrica y se habilitan automáticamente al encender el modo equipo.

## Mantenimiento

- Si tras una actualización de DSH cambia la lista de plugins de los presets de fábrica, resincroniza `cordis.patch.yml` desde los nuevos `presets/*.patch.yml` (conserva el doctrine suffix) y reinstala.
- Las líneas de protocolo (`[SWITCHMAN:LANG|POOLS|WATERMARK|TEAMS]`) están deliberadamente en inglés y son estables byte a byte — no las localices.
- `npm pack --dry-run` debe mantenerse en la forma auditada de 43 archivos / ~138 kB (las capturas de `docs/` no entran en el paquete).

## Licencia

MIT
