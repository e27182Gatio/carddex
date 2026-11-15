# Goldfish — instrucciones para revisión independiente de CardDex

> **No ejecutar esto dentro de la conversación que redactó la especificación.**
> Revisión genuina EGM = agente o sesión nueva sin acceso al historial de diseño, idealmente mediante plugin EGM con subagentes aislados.

## Entradas (únicas fuentes autorizadas)
1. https://github.com/e27182Gatio/carddex/blob/main/docs/egm/PHASE_2_DRAFT.md
2. https://github.com/e27182Gatio/carddex/blob/main/docs/egm/PROJECT_CONTEXT.md
3. Archivos del mismo repositorio citados por la especificación: `js/views/scan.js`, `js/card-detect.js`, `js/ocr.js`, `js/identify.js`, `js/api.js`, `js/match.js`, `js/store.js`, `sw.js`, `tests/card-detect.test.js`.

## Prompt reutilizable
Actúa como un revisor Goldfish, sin memoria del autor. Lee exclusivamente los dos documentos indicados y los archivos de código que mencionan. No consultes conversaciones anteriores, no supongas datos no escritos y no cambies código.

Realiza tres revisiones:
- **Comprensión:** explica objetivo, restricciones, invariantes, componentes afectados y secuencia; marca cualquier dato imposible de reconstruir.
- **Adversarial:** señala supuestos no probados, errores de arquitectura, condiciones de carrera, dobles capturas, hash collision, OCR falso, copias iguales, permisos de cámara, fallos de red, caché de service worker y privacidad. Prioriza hallazgos críticos/altos/medios y cita ruta + función exacta cuando sea posible.
- **Preparación:** determina si una persona desarrolladora podría implementar correctamente la fase 2 sin preguntas adicionales. Para cada bloqueo, indica qué frase o criterio debe añadirse al documento.

Entrega:
1. Semáforo de preparación (NO APTO / APTO CON CAMBIOS / APTO).
2. Tabla de hallazgos con ID, gravedad, evidencia, riesgo y corrección concreta en la especificación.
3. Lista de pruebas faltantes y definiciones pendientes.
4. Veredicto explícito sobre si se puede escribir código ya.

No afirmes que realizaste pruebas reales de cámara si no las ejecutaste. Si no tienes acceso a GitHub, decláralo y solicita el texto de los documentos; no inventes el contenido.
