# CardDex — EGM: diseño de Fase 2 (precisión y velocidad)
**Estado:** BORRADOR; pendiente de revisión Goldfish independiente y aprobación humana.
**Fecha:** 2026-11-15
**Contexto obligatorio:** [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md)
**Ámbito:** corregir y medir detección/reconocimiento antes de añadir escaneo masivo.
**Regla:** NO implementar este borrador directamente ni modificar `main` sin aprobación.

## 1. Problema
El usuario necesita apuntar a una carta Pokémon con Chrome en Android, verla detectada automáticamente y obtener una coincidencia correcta con poca espera. V3 tardaba y con frecuencia no activaba la captura automática. V4 tiene detección por bordes y flujo continuo en el código, pero **solo se validó con imágenes sintéticas**. No se conoce aún la latencia real ni las tasas de fallo en un POCO X7 Pro. Algunas cartas muy similares comparten nombre, número local o aspectos visuales, y una mala coincidencia no debe entrar al inventario silenciosamente.

### Alcance
- Medir primero el funcionamiento de V4 y fijar una línea base de precisión, detección, OCR, búsquedas y caché.
- Mejorar rendimiento de captura/detección y reconocimiento sin bajar artificialmente umbrales para esconder falsos negativos.
- Hacer explícitas las coincidencias ambiguas.
- Mantener cámara viva y separada del OCR; detener trabajos duplicados.

### Fuera de alcance
- Guardar lotes de forma definitiva (Fase 3).
- Inicio de sesión, sincronización, backend o cobros.
- Historial financiero o rediseño del álbum (Fase 4).
- Afirmar que una tarjeta holográfica/reverse es identificable con certeza a partir de una sola imagen sin validación.

### Invariantes
- La colección `localStorage["carddex.v1"]` no se borra, resetea ni cambia de esquema sin migración y respaldo.
- Las fotos se procesan localmente; IA externa solo mediante opción explícita y clave propia.
- Ninguna coincidencia, aunque sea de confianza alta, se agrega al inventario sin acción del usuario.
- El mismo ejemplar quieto no dispara lecturas sin fin; dos copias físicas idénticas pueden registrarse por separado mediante confirmación explícita.
- La captura manual, carga de imagen y exportación CSV siguen operativas.
- Continúa siendo una PWA estática compatible con GitHub Pages (subruta `/carddex/`).

## 2. Plan técnico

### 2.1 Línea base antes de tocar código
Preparar un conjunto local de evaluación con autorización del propietario, sin guardar fotografías en un repositorio público.
- Mínimo 20 cartas físicas distintas: múltiples generaciones, cartas con números coincidentes entre expansiones, variaciones de texto, acabados brillantes y al menos 2 copias iguales.
- Ejecutar 3 intentos por carta bajo iluminación uniforme, y repetir subconjunto con reflejos e inclinación.
- Registrar: éxito en detección de los 4 bordes, tiempo hasta captura automática, duración OCR, duración llamadas TCGdex, tiempo total hasta resultados, identificación exacta de expansión + número, falsos positivos sin carta y duplicados involuntarios.
- Registrar la velocidad de conexión, navegador, versión publicada y dispositivo; separar primer arranque (carga OCR) de arranques calientes.
- No fijar ahora una mejora porcentual ficticia. La meta cuantitativa se pacta una vez conocido el valor base.

### 2.2 Detección y cámara
- Separar estado de cámara de estado de reconocimiento: `idle -> seeking -> stable -> reading -> result`; el bucle de cámara no debe bloquearse en lecturas largas.
- `js/card-detect.js`: revisar falsos positivos y negativos del detector aproximado de bordes. Validar cuatro bordes, proporción de carta y posición en ROI. Devolver causa de rechazo solo para depuración local.
- `js/views/scan.js`: contar estabilidad por tiempo y no por velocidad variable del temporizador; una sola captura en curso; no capturar un fondo con textura; no reutilizar un frame obsoleto tras cambiar de pestaña/cámara.
- Usar un mecanismo de rearme basado en retirada de carta o cambio visual sustancial, pero el hash NO determina la identidad definitiva. Permitir botón visible de reintentar la misma carta.
- Mantener captura manual si el contorno no se detecta, sin bloquear el navegador.

### 2.3 OCR y búsqueda
- `js/ocr.js`: instrumentar cada etapa, dimensionar recortes para nombre/número, mantener un único worker Tesseract reutilizable y evaluar si las pasadas de respaldo aportan más exactitud que latencia. NO eliminar lecturas sin evidencia.
- `js/identify.js` / `js/api.js`: priorizar consultas limitadas por número/nombre, cachear resultados reusables, detener consultas cuando haya coincidencia inequívoca. Verificar en la API real las reglas de búsqueda exacta, ceros a la izquierda y nombres con sufijos (ex, V, GX, etc.) antes de adoptar filtros.
- `js/match.js`: distinguir la calidad de lectura OCR de la coincidencia con la base; comprobar siempre edición/expansión, número y nombre. Cuando dos candidatas estén próximas, marcar el caso como ambiguo y ofrecer opciones.
- Utilizar capturas de tarjetas reales como fixtures privados con expectativas explícitas, no como código público.

### 2.4 Observabilidad segura
- Mostrar estados `buscando bordes`, `carta estable`, `leyendo`, `buscando coincidencias`, `revisar resultado`, `siguiente carta`.
- Registrar métricas agregadas por sesión en memoria para poder medir mejoras. Exportar un diagnóstico sin fotos ni claves personales solo mediante gesto explícito.
- Etiquetar la versión visible y evitar mostrar V4 si el service worker aún entrega archivos anteriores.

## 3. Alternativas consideradas

| Alternativa | Ventaja | Riesgo | Decisión provisional |
|---|---|---|---|
| Relajar umbrales y lanzar OCR periódicamente | Fácil | Falsos positivos; consumo de CPU | Rechazada como solución principal |
| Tesseract en cada fotograma | No requiere nuevo detector | Rendimiento móvil deficiente | Rechazada |
| Detector geométrico liviano + OCR bajo demanda | Rápido y local | Fallos con perspectiva, bordes recortados | Preferida con pruebas reales |
| Modelo ML visual local | Potencialmente robusto | Tamaño, memoria, batería y complejidad | Evaluar solo si detector simple falla |
| Servicio OCR de pago | Puede mejorar algunos casos | Costos, privacidad y dependencia | No usar por defecto |

## 4. Implementación detallada (propuesta, sin código escrito)

### Secuencia
1. **Gate de Fase 1:** comprobar V4 en Android con 20 cartas y recopilar diagnósticos (sin alterar producción); bloquear fase 2 si el detector tiene alta tasa de fallos no cuantificada.
2. Fijar objetivos basados en línea base: separar tiempos fríos/calientes, tasa de identificación exacta y fallos de captura.
3. Abrir rama `egm/phase-2-recognition`; **no editar directamente main**.
4. Añadir instrumentación y pruebas de estados a `js/views/scan.js`, preservando cámara continua.
5. Probar y ajustar `js/card-detect.js` con casos de bordes inclinados, fondo complejo, brillo y carta ausente.
6. Optimizar OCR en `js/ocr.js` con mediciones antes/después, no por intuición.
7. Optimizar consultas en `js/api.js`, `js/identify.js` y validaciones en `js/match.js`; validar compatibilidad real de filtros.
8. Ejecutar `npm test`, validar manualmente captura y carga de foto, exportación CSV y conservación de `carddex.v1`.
9. Abrir PR con métricas antes/después y capturas de los mensajes de estado; revisión Goldfish del diff y aprobación humana.
10. Publicar, comprobar versión realmente servida por Pages y volver a medir en el mismo teléfono.

### Casos de aceptación
- Con una carta centrada y suficientemente visible, el detector comienza la captura sin pulsar un botón.
- Sin carta en cámara no debe iniciar OCR de manera repetitiva.
- Cámara permanece activa después de cada lectura y no duplica cartas inmóviles.
- Si falla el detector, la captura manual funciona.
- Si faltan nombre, número o expansión, no declarar `Found it` con alta confianza.
- Dos cartas de misma especie/numero con expansiones distintas no se confunden en la colección.
- Salir de la vista o cerrar navegador detiene la cámara y el trabajo asociado sin dejar temporizadores.
- Guardar, borrar, respaldar y exportar una colección existente continúan funcionando.
- La actualización del service worker no produce versiones mezcladas de scripts.
- Cada resultado reporta tiempos observados con una distinción clara entre OCR frío y caliente.

### Riesgos / decisiones sin resolver
1. Validar si la detección de cuatro bordes de la V4 tolera el encuadre real del celular.
2. Definir cómo se detecta una carta que ocupa casi todo el marco sin dejar borde visible.
3. Definir umbrales medibles para activación, reintentos, falsa captura y coincidencia ambigua tras la línea base.
4. Definir cuánto historial/diagnóstico guardar y por cuánto tiempo, sin almacenar imágenes por defecto.
5. Verificar si `localId` de TCGdex filtra correctamente números con ceros a la izquierda.
6. Acordar protocolo para dos copias físicas idénticas frente al mismo lente.
7. Diferenciar un error de OCR del error de búsqueda o de clasificación.

## Revisión EGM pendiente
Un **Goldfish genuino** debe ser una sesión/agente nuevo sin esta conversación: recibir solo este documento, `PROJECT_CONTEXT.md` y los archivos de código que aquí se mencionan.

Pasadas mínimas:
1. Comprensión: explicar la propuesta sin añadir supuestos.
2. Adversarial: intentar romperla con fallos de cámara, errores de OCR, pérdida de red, duplicados y caché.
3. Preparación: decidir si la especificación basta para implementar con rutas y criterios verificables.

**Puerta de aprobación:** no implementar Fase 2 hasta que esos hallazgos estén respondidos en este mismo documento y el propietario apruebe la especificación.
